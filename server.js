const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
require("dotenv").config();
const initSqlJs = require("sql.js");
const express = require("express");
const session = require("express-session");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");

const scrypt = promisify(crypto.scrypt);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

class SQLiteSessionStore extends session.Store {
    constructor(database) {
        super();
        this.database = database;
        this.getStatement = database.prepare("SELECT sess FROM sessions WHERE sid = ? AND expires_at > ?");
        this.setStatement = database.prepare(
            "INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires_at = excluded.expires_at"
        );
        this.destroyStatement = database.prepare("DELETE FROM sessions WHERE sid = ?");
        this.touchStatement = database.prepare("UPDATE sessions SET expires_at = ? WHERE sid = ?");
    }

    get(sessionId, callback) {
        try {
            const row = this.getStatement.get(sessionId, Date.now());
            callback(null, row ? JSON.parse(row.sess) : null);
        } catch (error) {
            callback(error);
        }
    }

    set(sessionId, value, callback = () => {}) {
        try {
            const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 86400000;
            this.setStatement.run(sessionId, JSON.stringify(value), expiresAt);
            callback(null);
        } catch (error) {
            callback(error);
        }
    }

    destroy(sessionId, callback = () => {}) {
        try {
            this.destroyStatement.run(sessionId);
            callback(null);
        } catch (error) {
            callback(error);
        }
    }

    touch(sessionId, value, callback = () => {}) {
        try {
            const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 86400000;
            this.touchStatement.run(expiresAt, sessionId);
            callback(null);
        } catch (error) {
            callback(error);
        }
    }
}

class PersistentSQLiteDatabase {
    constructor(database, databasePath) {
        this.database = database;
        this.databasePath = databasePath;
        this.transactionDepth = 0;
    }

    exec(sql) {
        this.database.exec(sql);
        this.persist();
    }

    prepare(sql) {
        return {
            get: (...params) => {
                const statement = this.database.prepare(sql);
                try {
                    statement.bind(params);
                    return statement.step() ? statement.getAsObject() : undefined;
                } finally {
                    statement.free();
                }
            },
            all: (...params) => {
                const statement = this.database.prepare(sql);
                const rows = [];
                try {
                    statement.bind(params);
                    while (statement.step()) rows.push(statement.getAsObject());
                    return rows;
                } finally {
                    statement.free();
                }
            },
            run: (...params) => {
                const statement = this.database.prepare(sql);
                try {
                    statement.run(params);
                    const changes = this.database.getRowsModified();
                    const row = this.database.exec("SELECT last_insert_rowid() AS id");
                    this.persist();
                    return {
                        changes,
                        lastInsertRowid: row[0]?.values[0]?.[0] ?? 0
                    };
                } finally {
                    statement.free();
                }
            }
        };
    }

    transaction(callback) {
        return (...args) => {
            this.database.exec("BEGIN IMMEDIATE");
            this.transactionDepth += 1;
            try {
                const result = callback(...args);
                this.transactionDepth -= 1;
                this.database.exec("COMMIT");
                this.persist();
                return result;
            } catch (error) {
                this.transactionDepth -= 1;
                this.database.exec("ROLLBACK");
                throw error;
            }
        };
    }

    persist() {
        if (this.transactionDepth > 0) return;
        const temporaryPath = `${this.databasePath}.tmp`;
        fs.writeFileSync(temporaryPath, Buffer.from(this.database.export()));
        fs.renameSync(temporaryPath, this.databasePath);
    }

    close() {
        this.persist();
        this.database.close();
    }
}

async function openDatabase(databasePath) {
    const SQL = await initSqlJs({
        locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
    });
    const data = fs.existsSync(databasePath) ? fs.readFileSync(databasePath) : undefined;
    const database = new PersistentSQLiteDatabase(new SQL.Database(data), databasePath);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('student', 'teacher')),
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS sessions (
            sid TEXT PRIMARY KEY,
            sess TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
        CREATE TABLE IF NOT EXISTS classrooms (
            id INTEGER PRIMARY KEY,
            teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            join_code TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS enrollments (
            classroom_id INTEGER NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
            student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            joined_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (classroom_id, student_id)
        );
        CREATE TABLE IF NOT EXISTS assignments (
            id INTEGER PRIMARY KEY,
            classroom_id INTEGER NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
            created_by INTEGER NOT NULL REFERENCES users(id),
            title TEXT NOT NULL,
            subject TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS submissions (
            id INTEGER PRIMARY KEY,
            assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
            student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'graded')),
            grade INTEGER,
            submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
            graded_at TEXT,
            UNIQUE (assignment_id, student_id)
        );
        CREATE TABLE IF NOT EXISTS quizzes (
            id INTEGER PRIMARY KEY,
            classroom_id INTEGER NOT NULL REFERENCES classrooms(id) ON DELETE CASCADE,
            created_by INTEGER NOT NULL REFERENCES users(id),
            title TEXT NOT NULL,
            question TEXT NOT NULL,
            correct_answer TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS quiz_attempts (
            quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
            student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            is_correct INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
            attempted_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (quiz_id, student_id)
        );
        CREATE TABLE IF NOT EXISTS points (
            id INTEGER PRIMARY KEY,
            classroom_id INTEGER REFERENCES classrooms(id) ON DELETE SET NULL,
            student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            awarded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            amount INTEGER NOT NULL CHECK (amount > 0 AND amount <= 1000),
            reason TEXT NOT NULL,
            source_key TEXT UNIQUE,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
    `);
    return database;
}

async function createApp(options = {}) {
    const dataDirectory = path.resolve(options.dataDirectory || process.env.DATA_DIR || path.join(__dirname, "data"));
    fs.mkdirSync(dataDirectory, { recursive: true });

    const databasePath = options.databasePath || path.join(dataDirectory, "ascendra.sqlite");
    const database = options.database || await openDatabase(databasePath);
    const isProduction = options.production ?? process.env.NODE_ENV === "production";

    let sessionSecret = options.sessionSecret || process.env.SESSION_SECRET;
    if (!sessionSecret && isProduction) {
        throw new Error("SESSION_SECRET must be set in production.");
    }
    if (!sessionSecret) {
        const secretPath = path.join(dataDirectory, "session-secret");
        try {
            sessionSecret = fs.readFileSync(secretPath, "utf8").trim();
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            sessionSecret = crypto.randomBytes(48).toString("hex");
            fs.writeFileSync(secretPath, `${sessionSecret}\n`, { flag: "wx", mode: 0o600 });
        }
    }

    const app = express();
    app.disable("x-powered-by");
    if (isProduction) app.set("trust proxy", 1);
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                baseUri: ["'self'"],
                connectSrc: ["'self'"],
                fontSrc: ["'self'", "data:"],
                formAction: ["'self'"],
                frameAncestors: ["'none'"],
                imgSrc: ["'self'", "data:"],
                objectSrc: ["'none'"],
                scriptSrc: ["'self'", "'unsafe-inline'"],
                styleSrc: ["'self'", "'unsafe-inline'"]
            }
        }
    }));
    app.use(express.json({ limit: "16kb", strict: true }));
    app.use(session({
        name: "ascendra.sid",
        secret: sessionSecret,
        store: new SQLiteSessionStore(database),
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: "lax",
            secure: isProduction,
            maxAge: 1000 * 60 * 60 * 24 * 7
        }
    }));

    const getUser = database.prepare("SELECT id, name, email, role FROM users WHERE id = ?");
    const getClassroomsForTeacher = database.prepare(
        "SELECT id, name, join_code AS joinCode, created_at AS createdAt FROM classrooms WHERE teacher_id = ? ORDER BY id"
    );
    const getClassroomsForStudent = database.prepare(`
        SELECT c.id, c.name, c.join_code AS joinCode, u.name AS teacherName
        FROM enrollments e
        JOIN classrooms c ON c.id = e.classroom_id
        JOIN users u ON u.id = c.teacher_id
        WHERE e.student_id = ?
        ORDER BY c.id
    `);

    function requireUser(req, res, next) {
        const user = req.session.userId ? getUser.get(req.session.userId) : null;
        if (!user) return res.status(401).json({ error: "Please sign in to continue." });
        req.user = user;
        next();
    }

    function requireRole(role) {
        return (req, res, next) => {
            if (req.user.role !== role) return res.status(403).json({ error: "You don't have permission to do that." });
            next();
        };
    }

    function requireSameOrigin(req, res, next) {
        const origin = req.get("origin");
        if (!origin) return res.status(403).json({ error: "A same-origin request is required." });
        try {
            const parsedOrigin = new URL(origin);
            if (parsedOrigin.host !== req.get("host")) {
                return res.status(403).json({ error: "Cross-origin requests are not allowed." });
            }
        } catch {
            return res.status(403).json({ error: "Invalid request origin." });
        }
        if (req.get("sec-fetch-site") === "cross-site") {
            return res.status(403).json({ error: "Cross-origin requests are not allowed." });
        }
        const suppliedToken = req.get("x-csrf-token");
        const expectedToken = req.session.csrfToken;
        if (!suppliedToken || !expectedToken) {
            return res.status(403).json({ error: "Refresh the page and try again." });
        }
        const supplied = Buffer.from(suppliedToken);
        const expected = Buffer.from(expectedToken);
        if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
            return res.status(403).json({ error: "Refresh the page and try again." });
        }
        next();
    }

    const authLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 10,
        standardHeaders: "draft-8",
        legacyHeaders: false,
        message: { error: "Too many sign-in attempts. Please wait a few minutes and try again." }
    });

    function validText(value, minimum, maximum) {
        return typeof value === "string" && value.trim().length >= minimum && value.trim().length <= maximum;
    }

    function makeClassCode() {
        let code = "";
        for (let index = 0; index < 8; index += 1) {
            code += codeAlphabet[crypto.randomInt(codeAlphabet.length)];
        }
        return `${code.slice(0, 4)}-${code.slice(4)}`;
    }

    function createClassroom(teacherId, name) {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const code = makeClassCode();
            try {
                return database.prepare(
                    "INSERT INTO classrooms (teacher_id, name, join_code) VALUES (?, ?, ?)"
                ).run(teacherId, name.trim(), code).lastInsertRowid;
            } catch (error) {
                if (!String(error.message).includes("UNIQUE constraint failed: classrooms.join_code")) throw error;
            }
        }
        throw new Error("Unable to generate a unique classroom code. Please try again.");
    }

    app.get("/api/health", (req, res) => res.json({ status: "ok" }));
    app.get("/api/csrf-token", (req, res, next) => {
        if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString("hex");
        res.json({ csrfToken: req.session.csrfToken });
    });
    app.post("/api/auth/signup", authLimiter, requireSameOrigin, async (req, res) => {
        const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
        const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
        const password = typeof req.body.password === "string" ? req.body.password : "";
        const role = req.body.role;
        if (!validText(name, 2, 80) || !emailPattern.test(email) || email.length > 254 || password.length < 10 || password.length > 128) {
            return res.status(400).json({ error: "Enter a name, valid email address, and password with at least 10 characters." });
        }
        if (role !== "student" && role !== "teacher") {
            return res.status(400).json({ error: "Choose student or teacher." });
        }
        const salt = crypto.randomBytes(16);
        const derivedKey = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
        const passwordHash = `scrypt$${salt.toString("hex")}$${derivedKey.toString("hex")}`;
        let result;
        try {
            result = database.prepare(
                "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)"
            ).run(name, email, passwordHash, role);
        } catch (error) {
            if (String(error.message).includes("UNIQUE constraint failed: users.email")) {
                return res.status(409).json({ error: "An account with that email already exists." });
            }
            throw error;
        }
        await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
        req.session.userId = Number(result.lastInsertRowid);
        req.session.csrfToken = crypto.randomBytes(32).toString("hex");
        res.status(201).json({ user: getUser.get(req.session.userId), csrfToken: req.session.csrfToken });
    });

    app.post("/api/auth/login", authLimiter, requireSameOrigin, async (req, res) => {
        const email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
        const password = typeof req.body.password === "string" ? req.body.password : "";
        const user = database.prepare("SELECT * FROM users WHERE email = ?").get(email);
        if (!user || password.length > 128) return res.status(401).json({ error: "Email or password is incorrect." });
        const [, saltHex, hashHex] = user.password_hash.split("$");
        const actual = await scrypt(password, Buffer.from(saltHex, "hex"), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
        const expected = Buffer.from(hashHex, "hex");
        if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
            return res.status(401).json({ error: "Email or password is incorrect." });
        }
        await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
        req.session.userId = user.id;
        req.session.csrfToken = crypto.randomBytes(32).toString("hex");
        res.json({ user: getUser.get(user.id), csrfToken: req.session.csrfToken });
    });

    app.post("/api/auth/logout", requireUser, requireSameOrigin, (req, res, next) => {
        req.session.destroy((error) => {
            if (error) return next(error);
            res.clearCookie("ascendra.sid", { httpOnly: true, sameSite: "lax", secure: isProduction });
            res.status(204).end();
        });
    });

    app.get("/api/me", requireUser, (req, res) => res.json({ user: req.user }));
    app.get("/api/dashboard", requireUser, (req, res) => {
        const classrooms = req.user.role === "teacher"
            ? getClassroomsForTeacher.all(req.user.id)
            : getClassroomsForStudent.all(req.user.id);
        const points = database.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM points WHERE student_id = ?").get(req.user.id).total;
        const classroomIds = classrooms.map((classroom) => classroom.id);
        let assignments = [];
        let quizzes = [];
        let submissions = [];
        let students = [];
        let classPoints = [];
        let leaderboard = [];
        let performance = [];
        let classAverage = null;

        if (classroomIds.length > 0) {
            const placeholders = classroomIds.map(() => "?").join(",");
            if (req.user.role === "teacher") {
                assignments = database.prepare(`
                    SELECT a.id, a.title, a.subject, a.classroom_id AS classroomId, c.name AS classroomName,
                           (SELECT COUNT(*) FROM submissions s WHERE s.assignment_id = a.id) AS submissionCount
                    FROM assignments a JOIN classrooms c ON c.id = a.classroom_id
                    WHERE a.classroom_id IN (${placeholders}) ORDER BY a.id DESC
                `).all(...classroomIds);
                quizzes = database.prepare(`
                    SELECT q.id, q.title, q.question, q.classroom_id AS classroomId, c.name AS classroomName
                    FROM quizzes q JOIN classrooms c ON c.id = q.classroom_id
                    WHERE q.classroom_id IN (${placeholders}) ORDER BY q.id DESC
                `).all(...classroomIds);
                submissions = database.prepare(`
                    SELECT s.id, s.assignment_id AS assignmentId, s.student_id AS studentId,
                           s.status, s.grade, a.title AS assignmentTitle, u.name AS studentName, c.name AS classroomName
                    FROM submissions s
                    JOIN assignments a ON a.id = s.assignment_id
                    JOIN users u ON u.id = s.student_id
                    JOIN classrooms c ON c.id = a.classroom_id
                    WHERE a.classroom_id IN (${placeholders}) AND s.status = 'submitted'
                    ORDER BY s.submitted_at
                `).all(...classroomIds);
                students = database.prepare(`
                    SELECT u.id, u.name, u.email, MIN(e.classroom_id) AS classroomId,
                           COALESCE((SELECT SUM(p.amount) FROM points p WHERE p.student_id = u.id), 0) AS points
                    FROM enrollments e JOIN users u ON u.id = e.student_id
                    WHERE e.classroom_id IN (${placeholders})
                    GROUP BY u.id, u.name, u.email ORDER BY u.name
                `).all(...classroomIds);
                classPoints = database.prepare(`
                    SELECT classroom_id AS classroomId, COALESCE(SUM(amount), 0) AS total
                    FROM points WHERE classroom_id IN (${placeholders}) GROUP BY classroom_id
                `).all(...classroomIds);
                performance = database.prepare(`
                    SELECT a.subject, ROUND(AVG(s.grade)) AS averageGrade, COUNT(*) AS gradedCount
                    FROM assignments a
                    JOIN submissions s ON s.assignment_id = a.id AND s.status = 'graded'
                    WHERE a.classroom_id IN (${placeholders})
                    GROUP BY a.subject ORDER BY a.subject
                `).all(...classroomIds);
                const average = database.prepare(`
                    SELECT ROUND(AVG(s.grade)) AS averageGrade
                    FROM assignments a
                    JOIN submissions s ON s.assignment_id = a.id AND s.status = 'graded'
                    WHERE a.classroom_id IN (${placeholders})
                `).get(...classroomIds);
                classAverage = average.averageGrade;
            } else {
                assignments = database.prepare(`
                    SELECT a.id, a.title, a.subject, a.classroom_id AS classroomId, c.name AS classroomName,
                           s.status AS submissionStatus, s.grade
                    FROM assignments a
                    JOIN classrooms c ON c.id = a.classroom_id
                    LEFT JOIN submissions s ON s.assignment_id = a.id AND s.student_id = ?
                    WHERE a.classroom_id IN (${placeholders}) ORDER BY a.id DESC
                `).all(req.user.id, ...classroomIds);
                quizzes = database.prepare(`
                    SELECT q.id, q.title, q.question, q.classroom_id AS classroomId, c.name AS classroomName,
                           qa.is_correct AS isCorrect
                    FROM quizzes q
                    JOIN classrooms c ON c.id = q.classroom_id
                    LEFT JOIN quiz_attempts qa ON qa.quiz_id = q.id AND qa.student_id = ?
                    WHERE q.classroom_id IN (${placeholders}) ORDER BY q.id DESC
                `).all(req.user.id, ...classroomIds);
                leaderboard = database.prepare(`
                    SELECT u.id, u.name, COALESCE(SUM(p.amount), 0) AS points
                    FROM enrollments e
                    JOIN users u ON u.id = e.student_id
                    LEFT JOIN points p ON p.student_id = u.id AND p.classroom_id = e.classroom_id
                    WHERE e.classroom_id = ?
                    GROUP BY u.id, u.name
                    ORDER BY points DESC, u.name
                    LIMIT 20
                `).all(classroomIds[0]);
            }
        }

        res.json({
            user: req.user,
            classrooms,
            assignments,
            quizzes,
            submissions,
            students,
            classPoints,
            leaderboard,
            performance,
            classAverage,
            points
        });
    });

    app.get("/api/classrooms", requireUser, (req, res) => {
        res.json({ classrooms: req.user.role === "teacher"
            ? getClassroomsForTeacher.all(req.user.id)
            : getClassroomsForStudent.all(req.user.id) });
    });

    app.post("/api/classrooms", requireUser, requireRole("teacher"), requireSameOrigin, (req, res) => {
        if (!validText(req.body.name, 2, 50)) return res.status(400).json({ error: "Classroom names must be 2–50 characters." });
        const classroomId = createClassroom(req.user.id, req.body.name);
        res.status(201).json({ classroom: getClassroomsForTeacher.all(req.user.id).find((item) => item.id === classroomId) });
    });

    app.post("/api/classrooms/join", requireUser, requireRole("student"), requireSameOrigin, (req, res) => {
        const code = typeof req.body.code === "string" ? req.body.code.trim().toUpperCase() : "";
        if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) return res.status(400).json({ error: "Enter a valid classroom code." });
        const classroom = database.prepare(`
            SELECT c.id, c.name, c.join_code AS joinCode, u.name AS teacherName
            FROM classrooms c JOIN users u ON u.id = c.teacher_id WHERE c.join_code = ?
        `).get(code);
        if (!classroom) return res.status(404).json({ error: "We couldn't find that class code. Check it with your teacher and try again." });
        try {
            database.prepare("INSERT INTO enrollments (classroom_id, student_id) VALUES (?, ?)").run(classroom.id, req.user.id);
        } catch (error) {
            if (String(error.message).includes("UNIQUE constraint failed")) {
                return res.status(409).json({ error: "You've already joined this classroom." });
            }
            throw error;
        }
        res.status(201).json({ classroom });
    });

    app.post("/api/assignments", requireUser, requireRole("teacher"), requireSameOrigin, (req, res) => {
        const classroom = database.prepare("SELECT id FROM classrooms WHERE id = ? AND teacher_id = ?")
            .get(Number(req.body.classroomId), req.user.id);
        if (!classroom) return res.status(404).json({ error: "Choose one of your classrooms first." });
        if (!validText(req.body.title, 2, 80) || !validText(req.body.subject, 2, 40)) {
            return res.status(400).json({ error: "Enter an assignment title and subject." });
        }
        const result = database.prepare(
            "INSERT INTO assignments (classroom_id, created_by, title, subject) VALUES (?, ?, ?, ?)"
        ).run(classroom.id, req.user.id, req.body.title.trim(), req.body.subject.trim());
        res.status(201).json({ assignment: database.prepare(
            "SELECT id, classroom_id AS classroomId, title, subject FROM assignments WHERE id = ?"
        ).get(result.lastInsertRowid) });
    });

    app.post("/api/assignments/:id/submit", requireUser, requireRole("student"), requireSameOrigin, (req, res) => {
        const assignment = database.prepare(`
            SELECT a.id FROM assignments a
            JOIN enrollments e ON e.classroom_id = a.classroom_id AND e.student_id = ?
            WHERE a.id = ?
        `).get(req.user.id, Number(req.params.id));
        if (!assignment) return res.status(404).json({ error: "Assignment not found in your classrooms." });
        try {
            const result = database.prepare("INSERT INTO submissions (assignment_id, student_id) VALUES (?, ?)").run(assignment.id, req.user.id);
            return res.status(201).json({ id: Number(result.lastInsertRowid), status: "submitted" });
        } catch (error) {
            if (String(error.message).includes("UNIQUE constraint failed")) {
                return res.status(409).json({ error: "You've already submitted this assignment." });
            }
            throw error;
        }
    });

    app.post("/api/submissions/:id/grade", requireUser, requireRole("teacher"), requireSameOrigin, (req, res) => {
        const grade = Number(req.body.grade);
        if (!Number.isInteger(grade) || grade < 0 || grade > 100) return res.status(400).json({ error: "Grades must be whole numbers from 0 to 100." });
        const submission = database.prepare(`
            SELECT s.id FROM submissions s
            JOIN assignments a ON a.id = s.assignment_id
            JOIN classrooms c ON c.id = a.classroom_id
            WHERE s.id = ? AND c.teacher_id = ? AND s.status = 'submitted'
        `).get(Number(req.params.id), req.user.id);
        if (!submission) return res.status(404).json({ error: "Submission not found or already graded." });
        database.prepare("UPDATE submissions SET status = 'graded', grade = ?, graded_at = datetime('now') WHERE id = ?")
            .run(grade, submission.id);
        res.json({ id: submission.id, status: "graded", grade });
    });

    app.post("/api/quizzes", requireUser, requireRole("teacher"), requireSameOrigin, (req, res) => {
        const classroom = database.prepare("SELECT id FROM classrooms WHERE id = ? AND teacher_id = ?")
            .get(Number(req.body.classroomId), req.user.id);
        if (!classroom) return res.status(404).json({ error: "Choose one of your classrooms first." });
        if (!validText(req.body.title, 2, 80) || !validText(req.body.question, 2, 160) || !validText(req.body.correctAnswer, 1, 80)) {
            return res.status(400).json({ error: "Enter a quiz title, question, and correct answer." });
        }
        const result = database.prepare(
            "INSERT INTO quizzes (classroom_id, created_by, title, question, correct_answer) VALUES (?, ?, ?, ?, ?)"
        ).run(classroom.id, req.user.id, req.body.title.trim(), req.body.question.trim(), req.body.correctAnswer.trim());
        res.status(201).json({ quiz: {
            id: Number(result.lastInsertRowid),
            title: req.body.title.trim(),
            question: req.body.question.trim(),
            classroomId: classroom.id
        } });
    });

    app.post("/api/quizzes/:id/attempt", requireUser, requireRole("student"), requireSameOrigin, (req, res) => {
        if (!validText(req.body.answer, 1, 80)) return res.status(400).json({ error: "Enter an answer." });
        const quiz = database.prepare(`
            SELECT q.id, q.classroom_id AS classroomId, q.correct_answer AS correctAnswer
            FROM quizzes q
            JOIN enrollments e ON e.classroom_id = q.classroom_id AND e.student_id = ?
            WHERE q.id = ?
        `).get(req.user.id, Number(req.params.id));
        if (!quiz) return res.status(404).json({ error: "Quiz not found in your classrooms." });
        const correct = req.body.answer.trim().toLocaleLowerCase() === quiz.correctAnswer.toLocaleLowerCase();
        try {
            database.prepare("INSERT INTO quiz_attempts (quiz_id, student_id, is_correct) VALUES (?, ?, ?)")
                .run(quiz.id, req.user.id, Number(correct));
            if (correct) {
                database.prepare(
                    "INSERT INTO points (classroom_id, student_id, amount, reason, source_key) VALUES (?, ?, 25, 'Quiz completed', ?)"
                ).run(quiz.classroomId, req.user.id, `quiz:${quiz.id}:${req.user.id}`);
            }
        } catch (error) {
            if (String(error.message).includes("UNIQUE constraint failed")) return res.status(409).json({ error: "You've already answered this quiz." });
            throw error;
        }
        res.json({ correct, pointsAwarded: correct ? 25 : 0 });
    });

    app.post("/api/classrooms/:id/points", requireUser, requireRole("teacher"), requireSameOrigin, (req, res) => {
        const classroom = database.prepare("SELECT id FROM classrooms WHERE id = ? AND teacher_id = ?")
            .get(Number(req.params.id), req.user.id);
        if (!classroom) return res.status(404).json({ error: "Classroom not found." });
        const amount = Number(req.body.amount);
        if (!Number.isInteger(amount) || amount < 1 || amount > 100) return res.status(400).json({ error: "Classroom awards must be from 1 to 100 points." });
        const insertAward = database.prepare(`
            INSERT INTO points (classroom_id, student_id, awarded_by, amount, reason, source_key)
            VALUES (?, ?, ?, ?, 'Teacher classroom reward', ?)
        `);
        const students = database.prepare("SELECT student_id FROM enrollments WHERE classroom_id = ?").all(classroom.id);
        if (students.length === 0) return res.status(409).json({ error: "Students need to join this classroom before you can award points." });
        const awardAll = database.transaction(() => {
            for (const student of students) {
                insertAward.run(classroom.id, student.student_id, req.user.id, amount, `award:${crypto.randomUUID()}`);
            }
        });
        awardAll();
        res.json({ studentsAwarded: students.length, amount });
    });

    app.post("/api/games/math-dragon/answer", requireUser, requireRole("student"), requireSameOrigin, (req, res) => {
        const correct = Number(req.body.answer) === 144;
        if (!correct) return res.json({ correct: false, pointsAwarded: 0 });
        const sourceKey = `math-dragon:${req.user.id}:${new Date().toISOString().slice(0, 10)}`;
        try {
            database.prepare(
                "INSERT INTO points (student_id, amount, reason, source_key) VALUES (?, 30, 'Math Dragon challenge', ?)"
            ).run(req.user.id, sourceKey);
            return res.json({ correct: true, pointsAwarded: 30 });
        } catch (error) {
            if (String(error.message).includes("UNIQUE constraint failed")) {
                return res.status(409).json({ error: "You've already earned today's Math Dragon reward." });
            }
            throw error;
        }
    });

    app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
    app.get("/index.html", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
    app.use((req, res) => res.status(404).json({ error: "Not found." }));
    app.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        console.error(error);
        if (error.type === "entity.parse.failed") return res.status(400).json({ error: "Request body must be valid JSON." });
        if (error.type === "entity.too.large") return res.status(413).json({ error: "Request body is too large." });
        res.status(500).json({ error: "Something went wrong. Please try again." });
    });

    app.locals.database = database;
    return app;
}

if (require.main === module) {
    const port = Number(process.env.PORT || 3000);
    const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
    createApp().then((app) => {
        const server = app.listen(port, host, () => {
            console.log(`Ascendra Learn is running at http://localhost:${port}`);
        });
        const shutdown = () => server.close(() => {
            app.locals.database.close();
            process.exit(0);
        });
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    }).catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = { createApp };

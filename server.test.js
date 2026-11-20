const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, beforeEach, test } = require("node:test");
const { createApp } = require("./server");

let dataDirectory;
let app;
let server;
let origin;

async function startServer() {
    app = await createApp({
        dataDirectory
    });
    server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
}

async function stopServer() {
    if (server) {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        server = null;
    }
    if (app) {
        app.locals.database.close();
        app = null;
    }
}

function createClient() {
    let cookie = "";
    let csrfToken = "";
    return {
        async request(route, { method = "GET", body, csrf = true, requestOrigin = origin, fetchSite = "same-origin" } = {}) {
            const headers = {
                Origin: requestOrigin,
                "Sec-Fetch-Site": fetchSite
            };
            if (cookie) headers.Cookie = cookie;
            if (body !== undefined) headers["Content-Type"] = "application/json";
            if (csrf && !["GET", "HEAD", "OPTIONS"].includes(method)) headers["X-CSRF-Token"] = csrfToken;
            const response = await fetch(new URL(route, origin), {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body)
            });
            const setCookie = response.headers.get("set-cookie");
            if (setCookie) cookie = setCookie.split(";")[0];
            const payload = response.status === 204 ? null : await response.json();
            if (payload?.csrfToken) csrfToken = payload.csrfToken;
            return { response, payload };
        },
        async initialize() {
            const { response, payload } = await this.request("/api/csrf-token");
            assert.equal(response.status, 200);
            csrfToken = payload.csrfToken;
        },
        async signup({ name, email, password = "strong-password-123", role }) {
            return this.request("/api/auth/signup", {
                method: "POST",
                body: { name, email, password, role }
            });
        }
    };
}

async function createUser({ name, email, role }) {
    const client = createClient();
    await client.initialize();
    const { response, payload } = await client.signup({ name, email, role });
    assert.equal(response.status, 201, JSON.stringify(payload));
    return { client, user: payload.user };
}

beforeEach(async () => {
    dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ascendra-learn-"));
    await startServer();
});

afterEach(async () => {
    await stopServer();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
});

test("allows teacher signup without an invite and persists sessions", async () => {
    const client = createClient();
    const privateServerSource = await fetch(new URL("/server.js", origin));
    const privatePackageManifest = await fetch(new URL("/package.json", origin));
    assert.equal(privateServerSource.status, 404);
    assert.equal(privatePackageManifest.status, 404);
    await client.initialize();

    const missingCsrf = await client.request("/api/auth/signup", {
        method: "POST",
        csrf: false,
        body: { name: "Teacher One", email: "teacher@example.edu", password: "strong-password-123", role: "teacher" }
    });
    assert.equal(missingCsrf.response.status, 403);

    const signup = await client.signup({
        name: "Teacher One",
        email: "teacher@example.edu",
        role: "teacher"
    });
    assert.equal(signup.response.status, 201, JSON.stringify(signup.payload));
    assert.equal(signup.payload.user.role, "teacher");
    assert.equal("password_hash" in signup.payload.user, false);

    const created = await client.request("/api/classrooms", {
        method: "POST",
        body: { name: "Room 8" }
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.payload));
    assert.match(created.payload.classroom.joinCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    await stopServer();
    await startServer();
    const persistedSession = await client.request("/api/me");
    assert.equal(persistedSession.response.status, 200);
    assert.equal(persistedSession.payload.user.email, "teacher@example.edu");
});

test("persists classrooms, assignments, quizzes, submissions, and points with role isolation", async () => {
    const teacher = await createUser({
        name: "Teacher One",
        email: "teacher@example.edu",
        role: "teacher"
    });
    const student = await createUser({
        name: "Student One",
        email: "student@example.edu",
        role: "student"
    });

    const unauthorizedClass = await student.client.request("/api/classrooms", {
        method: "POST",
        body: { name: "Not allowed" }
    });
    assert.equal(unauthorizedClass.response.status, 403);

    const classResponse = await teacher.client.request("/api/classrooms", {
        method: "POST",
        body: { name: "Math 8" }
    });
    const classroom = classResponse.payload.classroom;
    assert.equal(classResponse.response.status, 201);

    const joined = await student.client.request("/api/classrooms/join", {
        method: "POST",
        body: { code: classroom.joinCode.toLowerCase() }
    });
    assert.equal(joined.response.status, 201);
    const duplicateJoin = await student.client.request("/api/classrooms/join", {
        method: "POST",
        body: { code: classroom.joinCode }
    });
    assert.equal(duplicateJoin.response.status, 409);

    const assignmentResponse = await teacher.client.request("/api/assignments", {
        method: "POST",
        body: { classroomId: classroom.id, title: "Fractions", subject: "Math" }
    });
    assert.equal(assignmentResponse.response.status, 201);
    const assignmentId = assignmentResponse.payload.assignment.id;

    const quizResponse = await teacher.client.request("/api/quizzes", {
        method: "POST",
        body: { classroomId: classroom.id, title: "Quick check", question: "2 + 2?", correctAnswer: "4" }
    });
    assert.equal(quizResponse.response.status, 201);
    const quizId = quizResponse.payload.quiz.id;

    const studentDashboard = await student.client.request("/api/dashboard");
    assert.equal(studentDashboard.payload.classrooms.length, 1);
    assert.equal(studentDashboard.payload.assignments[0].title, "Fractions");
    assert.equal(studentDashboard.payload.quizzes[0].question, "2 + 2?");

    const submission = await student.client.request(`/api/assignments/${assignmentId}/submit`, { method: "POST", body: {} });
    assert.equal(submission.response.status, 201);
    const gradeResponse = await teacher.client.request(`/api/submissions/${submission.payload.id}/grade`, {
        method: "POST",
        body: { grade: 92 }
    });
    assert.equal(gradeResponse.response.status, 200);
    assert.equal(gradeResponse.payload.grade, 92);

    const attempt = await student.client.request(`/api/quizzes/${quizId}/attempt`, {
        method: "POST",
        body: { answer: "4" }
    });
    assert.equal(attempt.payload.correct, true);
    assert.equal(attempt.payload.pointsAwarded, 25);
    assert.equal((await student.client.request("/api/dashboard")).payload.points, 25);

    const award = await teacher.client.request(`/api/classrooms/${classroom.id}/points`, {
        method: "POST",
        body: { amount: 10 }
    });
    assert.equal(award.payload.studentsAwarded, 1);
    assert.equal((await student.client.request("/api/dashboard")).payload.points, 35);
    assert.equal((await student.client.request("/api/dashboard")).payload.leaderboard[0].name, "Student One");

    const teacherDashboard = await teacher.client.request("/api/dashboard");
    assert.equal(teacherDashboard.payload.submissions.length, 0);
    assert.equal(teacherDashboard.payload.students[0].name, "Student One");
    assert.equal(teacherDashboard.payload.classAverage, 92);
    assert.equal(teacherDashboard.payload.performance[0].subject, "Math");
    assert.equal(teacherDashboard.payload.performance[0].averageGrade, 92);

    await stopServer();
    await startServer();
    const persistedDashboard = await student.client.request("/api/dashboard");
    assert.equal(persistedDashboard.response.status, 200);
    assert.equal(persistedDashboard.payload.points, 35);
    assert.equal(persistedDashboard.payload.assignments[0].submissionStatus, "graded");
    assert.equal(persistedDashboard.payload.quizzes[0].isCorrect, 1);
    assert.equal(persistedDashboard.payload.leaderboard[0].points, 35);
});

test("rejects cross-origin writes, duplicate accounts, and replayed quiz rewards", async () => {
    const teacher = await createUser({
        name: "Teacher One",
        email: "teacher@example.edu",
        role: "teacher"
    });
    const student = await createUser({
        name: "Student One",
        email: "student@example.edu",
        role: "student"
    });
    const duplicate = await student.client.signup({
        name: "Duplicate",
        email: "STUDENT@example.edu",
        role: "student"
    });
    assert.equal(duplicate.response.status, 409);

    const crossOrigin = await student.client.request("/api/classrooms/join", {
        method: "POST",
        body: { code: "ABCD-EFGH" },
        requestOrigin: "https://example.com",
        fetchSite: "cross-site"
    });
    assert.equal(crossOrigin.response.status, 403);

    const classroom = (await teacher.client.request("/api/classrooms", {
        method: "POST",
        body: { name: "Math 8" }
    })).payload.classroom;
    await student.client.request("/api/classrooms/join", { method: "POST", body: { code: classroom.joinCode } });
    const quiz = (await teacher.client.request("/api/quizzes", {
        method: "POST",
        body: { classroomId: classroom.id, title: "Quick check", question: "2+2?", correctAnswer: "4" }
    })).payload.quiz;
    const firstAttempt = await student.client.request(`/api/quizzes/${quiz.id}/attempt`, {
        method: "POST",
        body: { answer: "4" }
    });
    const replay = await student.client.request(`/api/quizzes/${quiz.id}/attempt`, {
        method: "POST",
        body: { answer: "4" }
    });
    assert.equal(firstAttempt.response.status, 200);
    assert.equal(replay.response.status, 409);

    const game = await student.client.request("/api/games/math-dragon/answer", {
        method: "POST",
        body: { answer: 144 }
    });
    const duplicateGame = await student.client.request("/api/games/math-dragon/answer", {
        method: "POST",
        body: { answer: 144 }
    });
    assert.equal(game.payload.pointsAwarded, 30);
    assert.equal(duplicateGame.response.status, 409);

});

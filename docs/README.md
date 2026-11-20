# Ascendra Learn 🏫
**Learn. Achieve. Play.**

Ascendra Learn is a free, ad-free, all-in-one leaarning platform designed for students and teachers.

> 🚧 **Ascendra Learn is currently in early development. Features listed below are planned and may change.

## ✨ The Idea

School platforms shouldn't feel complicated or boring.

Ascendra Learn brings classroom tools, assignments, communication, rewards, learning resources, and games together in one sime platform.

## 🚀 Planned Features
**📚 Classroom**
- Assignments and quizzes
- Due dates and calender
- Teacher feedback and grading
- Student progress tracking
- Announcements
- Classroom resources

**⭐ Points & Rewards**
Teachers can award points for assignments, participation, improvement, teamwork, and other achievements.

Points can contribute toward achievments, progression, and Ascendra Learn's built-in games.

**🎮 Games**
Complete your work, earn points, and play!

Planned features include:
- Boss battles
- Progression and upgrades
- Achievements
- Classroom challenges
- Optional teacher-controlled leaderboards

**🪑 Smart Seating & Class Builder**
Teachers can create seating plans while considering student requests and teacher-defined requirements.

Future class-building tools could also help schools create balanced classes while considering student preferences and staff requirements.

**💬 Ascendra Connect**
A school-controlled communication system for:
- Classroom discussions
- Student-to-teacher messages
- Staff check-ins
- Asking for help
- Announcements

**📖 Ascendra Library**
A place for reading and learning resources, including:
- Books and stories
- Reading progress
- Assigned reading
- Reading Achievements
- Teacher-created resources

**📊 Teacher Tools**
- Assignment analytics
- Student Progress
- Class statistics
- Grade calculations
- Reports
- Exportable presentations
- Group generation
- Seating plans

**📆 Calendar**
One place for assignments, tests, events, deadlines, and classroom activity.

## 🌐 Part of Ascendra
Ascendra Learn is part of the Ascendra ecosystem.

Ascendra is focused on building useful, simple, and connected tools for productivity, learning, and creativity.

## 🔒 Privacy and Security
Ascendra Learn is being designed with student privacy in mind.

Student information, private messages, and school data should only be available to authorized users.

## 🖥️ Run the App Locally

The [homepage](../index.html) is served by a Node.js backend and SQLite database. Accounts, classroom join codes, assignments, quizzes, submissions, and points persist in the local `data/` directory.

1. Install Node.js 20 or newer.
2. From the project folder, run `npm install`.
3. Optionally copy `.env.example` to `.env` to customize local settings.
4. Run `npm start` and open `http://localhost:3000`.

Students and teachers can sign up directly without an invite code. This means anyone can create a teacher account; only deploy it in a trusted environment until school-controlled registration is added. Teachers create classrooms to generate unique join codes; share those codes with students. Set `SESSION_SECRET` to a strong random value before production deployment and serve the app over HTTPS.

Run the backend tests with `npm test`.

## 🛠️ Status

**Early Prototype**

Authentication and classroom data now use a local SQLite backend. The app still needs a production hosting setup, backups, account recovery, and a school-appropriate privacy review before real student data should be used.

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { generateRoutines, MAX_REQUESTED_COURSES } = require("./scheduler");

const PORT = process.env.PORT || 4000;
const COURSE_SOURCE_URL = "https://usis-cdn.eniamza.com/connect-migrate.json";

let inMemoryCatalog = {
  metadata: {},
  courses: [],
  loadedAt: null,
};

async function loadCourseCatalog() {
  const response = await axios.get(COURSE_SOURCE_URL, { timeout: 30000 });
  const payload = response.data || {};

  inMemoryCatalog = {
    metadata: payload.metadata || {},
    courses: Array.isArray(payload.courses) ? payload.courses : [],
    loadedAt: new Date().toISOString(),
  };
}

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    loadedAt: inMemoryCatalog.loadedAt,
    courseCount: inMemoryCatalog.courses.length,
  });
});

app.get("/api/course-codes", (req, res) => {
  const uniqueCodes = [...new Set(inMemoryCatalog.courses.map((course) => String(course.courseCode || "").toUpperCase()))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  res.json({
    totalCodes: uniqueCodes.length,
    courseCodes: uniqueCodes,
  });
});

app.get("/api/course-faculties", (req, res) => {
  const rawCodes = String(req.query.courseCodes || "");
  const requestedCodes = rawCodes
    .split(",")
    .map((code) => String(code || "").toUpperCase().trim())
    .filter(Boolean);

  const uniqueCodes = [...new Set(requestedCodes)];
  const facultiesByCourse = {};

  uniqueCodes.forEach((code) => {
    facultiesByCourse[code] = [];
  });

  inMemoryCatalog.courses.forEach((section) => {
    const code = String(section.courseCode || "").toUpperCase();
    if (!facultiesByCourse[code]) return;

    const faculty = String(section.faculties || "").toUpperCase().trim();
    if (!faculty || faculty === "TBA") return;

    facultiesByCourse[code].push(faculty);
  });

  uniqueCodes.forEach((code) => {
    facultiesByCourse[code] = [...new Set(facultiesByCourse[code])].sort((a, b) => a.localeCompare(b));
  });

  res.json({
    facultiesByCourse,
  });
});

app.post("/api/generate-routine", (req, res) => {
  try {
    const { courseCodes, preferences } = req.body || {};

    const normalizedCourseCodes = (Array.isArray(courseCodes) ? courseCodes : [])
      .map((code) => String(code || "").toUpperCase().trim())
      .filter(Boolean);

    const uniqueCourseCodes = [...new Set(normalizedCourseCodes)];

    if (uniqueCourseCodes.length > MAX_REQUESTED_COURSES) {
      return res.status(400).json({
        error: `A maximum of ${MAX_REQUESTED_COURSES} courses can be requested at once. Please reduce your selection.`,
      });
    }

    const routines = generateRoutines(inMemoryCatalog.courses, uniqueCourseCodes, preferences);

    res.json({
      routines,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = String(error?.message || "");
    const knownMessage =
      message === "Cannot generate schedule with these constraints" ||
      message.includes("At least one course code") ||
      message.includes("maximum of");

    res.status(400).json({
      error: knownMessage ? message : "Cannot generate schedule with these constraints",
    });
  }
});

(async () => {
  try {
    console.log("Loading course catalog into memory...");
    await loadCourseCatalog();
    console.log(`Catalog loaded. Sections in memory: ${inMemoryCatalog.courses.length}`);

    app.listen(PORT, () => {
      console.log(`Routine Generator backend listening on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to load course catalog on startup.");
    console.error(error);
    process.exit(1);
  }
})();
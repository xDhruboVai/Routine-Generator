const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { generateRoutines, MAX_REQUESTED_COURSES } = require("./scheduler");

const PORT = process.env.PORT || 4000;
const COURSE_SOURCE_URL =
  process.env.COURSE_SOURCE_URL || "https://usis-cdn.eniamza.com/connect-migrate.json";
const CATALOG_FETCH_TIMEOUT_MS = Number(process.env.CATALOG_FETCH_TIMEOUT_MS || 30000);
const CATALOG_REFRESH_INTERVAL_MS = Math.max(
  5000,
  Number(process.env.CATALOG_REFRESH_INTERVAL_MS || 15000),
);

let inMemoryCatalog = {
  metadata: {},
  courses: [],
  loadedAt: null,
};

let catalogReady = false;
let refreshInProgress = false;
let sourceHealth = {
  sourceReachable: false,
  lastRefreshAttemptAt: null,
  lastRefreshCompletedAt: null,
  lastSuccessfulLoadAt: null,
  lastRefreshError: null,
};

function applyCatalog(payload) {
  inMemoryCatalog = {
    metadata: payload.metadata || {},
    courses: Array.isArray(payload.courses) ? payload.courses : [],
    loadedAt: new Date().toISOString(),
  };
}

async function refreshCourseCatalog(reason = "interval") {
  if (refreshInProgress) {
    return;
  }

  refreshInProgress = true;
  sourceHealth.lastRefreshAttemptAt = new Date().toISOString();

  try {
    const response = await axios.get(COURSE_SOURCE_URL, { timeout: CATALOG_FETCH_TIMEOUT_MS });
    const payload = response.data || {};

    applyCatalog(payload);

    catalogReady = true;
    sourceHealth.sourceReachable = true;
    sourceHealth.lastSuccessfulLoadAt = inMemoryCatalog.loadedAt;
    sourceHealth.lastRefreshError = null;

    console.log(
      `Catalog refresh (${reason}) succeeded. Sections in memory: ${inMemoryCatalog.courses.length}. Source lastUpdated: ${inMemoryCatalog.metadata?.lastUpdated || "N/A"}`,
    );
  } catch (error) {
    catalogReady = false;
    sourceHealth.sourceReachable = false;
    sourceHealth.lastRefreshError = String(error?.message || "Unknown source fetch error");

    console.error(
      `Catalog refresh (${reason}) failed: ${sourceHealth.lastRefreshError}`,
    );
  } finally {
    sourceHealth.lastRefreshCompletedAt = new Date().toISOString();
    refreshInProgress = false;
  }
}

function startCatalogRefreshLoop() {
  setInterval(() => {
    refreshCourseCatalog("poll");
  }, CATALOG_REFRESH_INTERVAL_MS);
}

function requireCatalogReady(req, res, next) {
  if (catalogReady && Array.isArray(inMemoryCatalog.courses) && inMemoryCatalog.courses.length > 0) {
    next();
    return;
  }

  res.status(503).json({
    error: "Course catalog is temporarily unavailable. Please try again shortly.",
  });
}

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => {
  res.json({
    ok: catalogReady,
    sourceReachable: sourceHealth.sourceReachable,
    sourceMetadataLastUpdated: inMemoryCatalog.metadata?.lastUpdated || null,
    lastRefreshAttemptAt: sourceHealth.lastRefreshAttemptAt,
    lastRefreshCompletedAt: sourceHealth.lastRefreshCompletedAt,
    lastSuccessfulLoadAt: sourceHealth.lastSuccessfulLoadAt,
    lastRefreshError: sourceHealth.lastRefreshError,
    loadedAt: inMemoryCatalog.loadedAt,
    courseCount: inMemoryCatalog.courses.length,
  });
});

app.use("/api/course-codes", requireCatalogReady);
app.get("/api/course-codes", (req, res) => {
  const uniqueCodes = [...new Set(inMemoryCatalog.courses.map((course) => String(course.courseCode || "").toUpperCase()))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  res.json({
    totalCodes: uniqueCodes.length,
    courseCodes: uniqueCodes,
  });
});

app.use("/api/course-faculties", requireCatalogReady);
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

app.use("/api/generate-routine", requireCatalogReady);
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

    const generation = generateRoutines(inMemoryCatalog.courses, uniqueCourseCodes, preferences);

    res.json({
      routines: generation.routines,
      stats: generation.stats,
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
  console.log("Loading course catalog into memory...");
  await refreshCourseCatalog("startup");
  startCatalogRefreshLoop();

  app.listen(PORT, () => {
    console.log(`Routiner Khichuri backend listening on port ${PORT}`);
  });
})();
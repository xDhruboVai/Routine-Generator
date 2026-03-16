import { Fragment, useEffect, useMemo, useState } from "react";
import axios from "axios";
import "./App.css";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "http://localhost:4000";
const DAY_ORDER = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
const TIME_SLOTS = [
  { label: "08:00 AM-09:20 AM", startTime: "08:00:00", endTime: "09:20:00" },
  { label: "09:30 AM-10:50 AM", startTime: "09:30:00", endTime: "10:50:00" },
  { label: "11:00 AM-12:20 PM", startTime: "11:00:00", endTime: "12:20:00" },
  { label: "12:30 PM-01:50 PM", startTime: "12:30:00", endTime: "13:50:00" },
  { label: "02:00 PM-03:20 PM", startTime: "14:00:00", endTime: "15:20:00" },
  { label: "03:30 PM-04:50 PM", startTime: "15:30:00", endTime: "16:50:00" },
  { label: "05:00 PM-06:20 PM", startTime: "17:00:00", endTime: "18:20:00" },
];

function toMinutes(value) {
  if (!value) return 0;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function normalizeMeetingsFromSections(sections) {
  return sections.flatMap((section, sectionIndex) => {
    const schedule = section.sectionSchedule || {};
    const classSchedules = Array.isArray(schedule.classSchedules) ? schedule.classSchedules : [];
    const nestedLabSchedules = Array.isArray(schedule.labSchedules) ? schedule.labSchedules : [];
    const rootLabSchedules = Array.isArray(section.labSchedules) ? section.labSchedules : [];
    const labSchedules = [...nestedLabSchedules, ...rootLabSchedules];

    const classMeetings = classSchedules.map((meeting) => ({
      ...meeting,
      meetingType: "THEORY",
    }));

    const labMeetings = labSchedules.map((meeting) => ({
      ...meeting,
      meetingType: "LAB",
    }));

    return [...classMeetings, ...labMeetings].map((meeting, meetingIndex) => ({
      day: String(meeting.day || "").toUpperCase(),
      startMinutes: toMinutes(meeting.startTime),
      endMinutes: toMinutes(meeting.endTime),
      startTime: meeting.startTime,
      endTime: meeting.endTime,
      meetingType: meeting.meetingType || "THEORY",
      courseCode: section.courseCode,
      sectionName: section.sectionName,
      faculty: section.faculties,
      remainingSeats:
        Number.isFinite(Number(section.remainingSeats))
          ? Number(section.remainingSeats)
          : null,
      meetingKey: `${section.courseCode}-${section.sectionName}-${meeting.day}-${meeting.startTime}-${meeting.endTime}-${meeting.meetingType}-${sectionIndex}-${meetingIndex}`,
    }));
  });
}

const COURSE_PALETTE = [
  { bg: "#fdf3d5", border: "#d09f1f", text: "#4f3500" },
  { bg: "#def8e8", border: "#329e62", text: "#0e4929" },
  { bg: "#dff1ff", border: "#2f83c6", text: "#0d3960" },
  { bg: "#fbe6e3", border: "#cc604f", text: "#5d1f16" },
  { bg: "#ece8ff", border: "#7267ce", text: "#2f286f" },
  { bg: "#ffe6f6", border: "#bb4c9a", text: "#5b1d48" },
  { bg: "#e7f6f2", border: "#2d9f93", text: "#0f4f48" },
  { bg: "#fff1e2", border: "#ce7f2d", text: "#613605" },
];

function buildCourseColorMap(sections) {
  const uniqueCodes = [...new Set(sections.map((section) => String(section.courseCode || "")))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const colorMap = new Map();
  uniqueCodes.forEach((code, index) => {
    colorMap.set(code, COURSE_PALETTE[index % COURSE_PALETTE.length]);
  });

  return colorMap;
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function WeeklyCalendar({ sections }) {
  const meetings = useMemo(() => normalizeMeetingsFromSections(sections), [sections]);
  const courseColorMap = useMemo(() => buildCourseColorMap(sections), [sections]);

  const slotMap = useMemo(() => {
    const map = new Map();

    DAY_ORDER.forEach((day) => {
      const dayMeetings = meetings.filter((meeting) => meeting.day === day);

      TIME_SLOTS.forEach((slot, slotIndex) => {
        const slotStart = toMinutes(slot.startTime);
        const slotEnd = toMinutes(slot.endTime);

        const matchedMeetings = dayMeetings.filter((meeting) =>
          overlaps(meeting.startMinutes, meeting.endMinutes, slotStart, slotEnd),
        );

        map.set(`${day}-${slotIndex}`, matchedMeetings);
      });
    });

    return map;
  }, [meetings]);

  if (meetings.length === 0) {
    return <div className="calendar-empty">No class meetings found for this routine.</div>;
  }

  return (
    <div className="calendar-wrapper">
      <div className="calendar-legend">
        <div className="legend-types">
          <span className="type-pill theory">Theory</span>
          <span className="type-pill lab">Lab</span>
        </div>
        <div className="legend-courses">
          {[...courseColorMap.entries()].map(([courseCode, color]) => (
            <div key={courseCode} className="course-legend-item">
              <span
                className="course-legend-swatch"
                style={{
                  backgroundColor: color.bg,
                  borderColor: color.border,
                }}
              />
              <span>{courseCode}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="calendar-scroll">
        <table className="slot-table">
          <thead>
            <tr>
              <th>Time/Day</th>
              {DAY_ORDER.map((day) => (
                <th key={day}>{day.charAt(0) + day.slice(1).toLowerCase()}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TIME_SLOTS.map((slot, slotIndex) => (
              <tr key={slot.label}>
                <td className="slot-label">{slot.label}</td>
                {DAY_ORDER.map((day) => {
                  const items = slotMap.get(`${day}-${slotIndex}`) || [];
                  return (
                    <td key={`${day}-${slot.label}`} className="slot-cell">
                      <div className="slot-events">
                        {items.map((meeting) => (
                          <div
                            key={`${meeting.courseCode}-${meeting.day}-${meeting.startTime}-${meeting.sectionName}-${meeting.meetingType}`}
                            className={`slot-event-card ${meeting.meetingType === "LAB" ? "is-lab" : "is-theory"}`}
                            style={{
                              "--event-bg": courseColorMap.get(meeting.courseCode)?.bg || "#e7f6f2",
                              "--event-border": courseColorMap.get(meeting.courseCode)?.border || "#2d9f93",
                              "--event-text": courseColorMap.get(meeting.courseCode)?.text || "#0f4f48",
                            }}
                          >
                            <div className="slot-event-title">{meeting.courseCode}</div>
                            <div className="slot-event-type">{meeting.meetingType}</div>
                            <div className="slot-event-meta">
                              {meeting.sectionName} | {meeting.faculty}
                            </div>
                            <div className="slot-event-seats">
                              Remaining seats: {meeting.remainingSeats == null ? "N/A" : meeting.remainingSeats}
                            </div>
                          </div>
                        ))}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function App() {
  const ROUTINES_PER_PAGE = 5;

  const [allCodes, setAllCodes] = useState([]);
  const [codeQuery, setCodeQuery] = useState("");
  const [selectedCodes, setSelectedCodes] = useState([]);
  const [allowedDays, setAllowedDays] = useState([...DAY_ORDER]);

  const [maxDaysPerWeek, setMaxDaysPerWeek] = useState(4);
  const [priority, setPriority] = useState("MIN_DAYS");

  const [facultyPrefsByCourse, setFacultyPrefsByCourse] = useState({});
  const [facultyOptionsByCourse, setFacultyOptionsByCourse] = useState({});

  const [preferBreaks, setPreferBreaks] = useState(true);
  const [ignoreFilledSections, setIgnoreFilledSections] = useState(true);

  const [loadingCodes, setLoadingCodes] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [routines, setRoutines] = useState([]);
  const [routineStats, setRoutineStats] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [errorMessage, setErrorMessage] = useState("");
  const [sourceLastUpdated, setSourceLastUpdated] = useState(null);

  useEffect(() => {
    async function fetchCourseCodes() {
      try {
        setLoadingCodes(true);
        const response = await axios.get(`${API_BASE_URL}/api/course-codes`);
        setAllCodes(response.data.courseCodes || []);
      } catch (error) {
        setErrorMessage("Could not load course codes from backend.");
      } finally {
        setLoadingCodes(false);
      }
    }

    fetchCourseCodes();
  }, []);

  useEffect(() => {
    document.title = "Routiner Khichuri";
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function fetchHealthStatus() {
      try {
        const response = await axios.get(`${API_BASE_URL}/api/health`);
        if (!isMounted) return;
        setSourceLastUpdated(response.data?.sourceMetadataLastUpdated || null);
      } catch {
        if (!isMounted) return;
        setSourceLastUpdated(null);
      }
    }

    fetchHealthStatus();
    const intervalId = setInterval(fetchHealthStatus, 120000);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    function handlePointerMove(event) {
      document.documentElement.style.setProperty("--cursor-x", `${event.clientX}px`);
      document.documentElement.style.setProperty("--cursor-y", `${event.clientY}px`);
    }

    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
    };
  }, []);

  const filteredSuggestions = useMemo(() => {
    const query = codeQuery.trim().toUpperCase();
    if (!query) return [];

    return allCodes
      .filter((code) => code.includes(query) && !selectedCodes.includes(code))
      .slice(0, 12);
  }, [allCodes, codeQuery, selectedCodes]);

  function addCourseCode(code) {
    const normalized = String(code || "").toUpperCase().trim();
    if (!normalized || selectedCodes.includes(normalized)) return;
    setSelectedCodes((previous) => [...previous, normalized]);
    setFacultyPrefsByCourse((previous) => ({
      ...previous,
      [normalized]: { preferredList: [], avoidList: [] },
    }));
    setCodeQuery("");
  }

  function removeCourseCode(code) {
    setSelectedCodes((previous) => previous.filter((value) => value !== code));
    setFacultyPrefsByCourse((previous) => {
      const next = { ...previous };
      delete next[code];
      return next;
    });
  }

  function toggleAllowedDay(day) {
    setAllowedDays((previous) => {
      if (previous.includes(day)) {
        if (previous.length === 1) return previous;
        return previous.filter((value) => value !== day);
      }
      return [...previous, day];
    });
  }

  function toggleFacultyPreference(courseCode, field, faculty) {
    setFacultyPrefsByCourse((previous) => {
      const current = previous[courseCode] || { preferredList: [], avoidList: [] };
      const existing = Array.isArray(current[field]) ? current[field] : [];
      const normalizedFaculty = String(faculty || "").toUpperCase();
      const nextValues = existing.includes(normalizedFaculty)
        ? existing.filter((value) => value !== normalizedFaculty)
        : [...existing, normalizedFaculty];

      return {
        ...previous,
        [courseCode]: {
          preferredList: current.preferredList || [],
          avoidList: current.avoidList || [],
          [field]: nextValues,
        },
      };
    });
  }

  useEffect(() => {
    async function fetchFacultyOptions() {
      if (selectedCodes.length === 0) {
        setFacultyOptionsByCourse({});
        return;
      }

      try {
        const query = encodeURIComponent(selectedCodes.join(","));
        const response = await axios.get(`${API_BASE_URL}/api/course-faculties?courseCodes=${query}`);
        setFacultyOptionsByCourse(response.data.facultiesByCourse || {});
      } catch {
        setFacultyOptionsByCourse({});
      }
    }

    fetchFacultyOptions();
  }, [selectedCodes]);

  async function generateRoutine() {
    try {
      setErrorMessage("");
      setIsGenerating(true);

      const mustHaveByCourse = {};
      const avoidByCourse = {};

      selectedCodes.forEach((code) => {
        const prefs = facultyPrefsByCourse[code] || {};
        const mustHave = Array.isArray(prefs.preferredList)
          ? prefs.preferredList.map((value) => String(value || "").toUpperCase()).filter(Boolean)
          : [];
        const avoid = Array.isArray(prefs.avoidList)
          ? prefs.avoidList.map((value) => String(value || "").toUpperCase()).filter(Boolean)
          : [];

        if (mustHave.length > 0) {
          mustHaveByCourse[code] = mustHave;
        }

        if (avoid.length > 0) {
          avoidByCourse[code] = avoid;
        }
      });

      const payload = {
        courseCodes: selectedCodes,
        preferences: {
          maxDaysPerWeek,
          allowedDays,
          priority,
          facultyPreference: {
            mustHaveByCourse,
            avoidByCourse,
          },
          breakPreference: {
            enabled: preferBreaks,
          },
          ignoreFilledSections,
        },
      };

      const response = await axios.post(`${API_BASE_URL}/api/generate-routine`, payload);
      const sorted = [...(response.data.routines || [])].sort(
        (a, b) => (b.metrics?.score || 0) - (a.metrics?.score || 0),
      );
      setRoutines(sorted);
      setRoutineStats(response.data.stats || null);
      setCurrentPage(1);
    } catch (error) {
      setRoutines([]);
      setRoutineStats(null);
      const message =
        error?.response?.data?.error || "Cannot generate schedule with these constraints";
      setErrorMessage(message);
    } finally {
      setIsGenerating(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(routines.length / ROUTINES_PER_PAGE));
  const pageStartIndex = (currentPage - 1) * ROUTINES_PER_PAGE;
  const pageRoutines = routines.slice(pageStartIndex, pageStartIndex + ROUTINES_PER_PAGE);

  return (
    <div className="app-shell">
      <div className="ambient-bg" aria-hidden="true">
        <div className="wave wave-a" />
        <div className="wave wave-b" />
        <div className="wave wave-c" />
      </div>

      <header className="hero-header">
        <h1>ROUTINER KHICHURI</h1>
        <p>Aj prochur routiner banabo.</p>
        <p className="source-last-updated-text">
          Source last updated: {sourceLastUpdated ? new Date(sourceLastUpdated).toLocaleString() : "Unavailable"}
        </p>
      </header>

      <section className="panel">
        <h2>Course Selection</h2>
        <div className="course-search-area">
          <input
            value={codeQuery}
            onChange={(event) => setCodeQuery(event.target.value)}
            placeholder="Search course code (e.g., CSE111)"
          />
          <button type="button" onClick={() => addCourseCode(codeQuery)}>
            Add
          </button>
        </div>

        {loadingCodes && <p className="hint-text">Loading course list...</p>}

        {filteredSuggestions.length > 0 && (
          <div className="suggestion-row">
            {filteredSuggestions.map((code) => (
              <button key={code} type="button" className="suggestion-pill" onClick={() => addCourseCode(code)}>
                {code}
              </button>
            ))}
          </div>
        )}

        <div className="chip-row">
          {selectedCodes.map((code) => (
            <span key={code} className="code-chip">
              {code}
              <button type="button" onClick={() => removeCourseCode(code)}>
                x
              </button>
            </span>
          ))}
        </div>

        {selectedCodes.length > 0 && (
          <div className="course-pref-grid">
            <div className="course-pref-head">Course</div>
            <div className="course-pref-head">Preferred Faculties</div>
            <div className="course-pref-head">Faculties To Avoid</div>

            {selectedCodes.map((code) => (
              <Fragment key={code}>
                <div className="course-pref-code">{code}</div>

                <div className="faculty-option-list">
                  {(facultyOptionsByCourse[code] || []).map((faculty) => (
                    <label key={`${code}-preferred-${faculty}`} className="faculty-option-item">
                      <input
                        type="checkbox"
                        checked={(facultyPrefsByCourse[code]?.preferredList || []).includes(faculty)}
                        onChange={() => toggleFacultyPreference(code, "preferredList", faculty)}
                      />
                      <span>{faculty}</span>
                    </label>
                  ))}
                </div>

                <div className="faculty-option-list">
                  {(facultyOptionsByCourse[code] || []).map((faculty) => (
                    <label key={`${code}-avoid-${faculty}`} className="faculty-option-item">
                      <input
                        type="checkbox"
                        checked={(facultyPrefsByCourse[code]?.avoidList || []).includes(faculty)}
                        onChange={() => toggleFacultyPreference(code, "avoidList", faculty)}
                      />
                      <span>{faculty}</span>
                    </label>
                  ))}
                </div>
              </Fragment>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Scheduling Settings</h2>
        <div className="sub-panel day-selector-panel">
          <h3>Preferred Class Days</h3>
          <div className="day-toggle-bar">
            {DAY_ORDER.map((day) => {
              const enabled = allowedDays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  className={`day-toggle ${enabled ? "is-selected" : ""}`}
                  onClick={() => toggleAllowedDay(day)}
                >
                  {day.slice(0, 3)}
                </button>
              );
            })}
          </div>
          <p className="hint-text">Only sections scheduled within selected days will be considered.</p>
        </div>

        <div className="settings-grid">
          <label>
            Max Days Per Week
            <input type="number" min="1" max="7" value={maxDaysPerWeek} onChange={(event) => setMaxDaysPerWeek(Number(event.target.value || 1))} />
          </label>

          <label>
            Priority
            <select value={priority} onChange={(event) => setPriority(event.target.value)}>
              <option value="MIN_DAYS">Minimum Days</option>
              <option value="MIN_DAILY_HOURS">Minimum Daily Hours</option>
            </select>
          </label>
        </div>

        <div className="sub-panel">
          <h3>Section Availability</h3>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={ignoreFilledSections}
              onChange={(event) => setIgnoreFilledSections(event.target.checked)}
            />
            Ignore filled sections
          </label>
          <p className="hint-text">Default is enabled. Full means consumed seats are greater than or equal to capacity.</p>
        </div>

        <div className="sub-panel">
          <h3>Break Preference</h3>
          <label className="checkbox-label">
            <input type="checkbox" checked={preferBreaks} onChange={(event) => setPreferBreaks(event.target.checked)} />
            Prefer routines with breaks between consecutive classes
          </label>
          <p className="hint-text">Break scoring is automatically calculated based on the fixed 1 hour 20 minute class slots.</p>
        </div>

        <button className="generate-button" type="button" disabled={selectedCodes.length === 0 || isGenerating} onClick={generateRoutine}>
          {isGenerating ? "Generating..." : "Generate Routine"}
        </button>
      </section>

      {errorMessage && <div className="error-banner">{errorMessage}</div>}

      <section className="panel results-panel">
        <h2>Results</h2>
        {routines.length === 0 && !errorMessage && <p className="hint-text">Generate a routine to view schedules.</p>}

        {routines.length > 0 && (
          <div className="results-summary">
            <span>
              Created <strong>{routineStats?.generatedRoutines ?? routines.length}</strong> routines from
              <strong> {routineStats?.totalCombinations ?? "N/A"}</strong> combinations.
            </span>
            <span>
              Page <strong>{currentPage}</strong> of <strong>{totalPages}</strong>
            </span>
          </div>
        )}

        <div className="results-stack">
          {pageRoutines.map((routine, index) => (
            <article key={`routine-${pageStartIndex + index}`} className="result-card">
              <div className="result-header">
                <h3>Routine #{pageStartIndex + index + 1}</h3>
                <p>
                  Score: <strong>{Math.round(routine.metrics.score || 0)}</strong> | Days: <strong>{routine.metrics.totalDays}</strong> | Total Hours: <strong>{routine.metrics.totalHours.toFixed(2)}</strong> | Avg Daily: <strong>{routine.metrics.avgDailyHours.toFixed(2)}</strong>
                </p>
              </div>

              <WeeklyCalendar sections={routine.sections} />
            </article>
          ))}
        </div>

        {routines.length > ROUTINES_PER_PAGE && (
          <div className="results-pagination">
            <button
              type="button"
              className="page-btn"
              disabled={currentPage === 1}
              onClick={() => {
                setCurrentPage((previous) => Math.max(1, previous - 1));
              }}
            >
              Previous
            </button>

            {Array.from({ length: totalPages }, (_, index) => index + 1).map((page) => (
              <button
                key={page}
                type="button"
                className={`page-btn page-number ${page === currentPage ? "is-active" : ""}`}
                onClick={() => {
                  setCurrentPage(page);
                }}
              >
                {page}
              </button>
            ))}

            <button
              type="button"
              className="page-btn"
              disabled={currentPage === totalPages}
              onClick={() => {
                setCurrentPage((previous) => Math.min(totalPages, previous + 1));
              }}
            >
              Next
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

export default App;

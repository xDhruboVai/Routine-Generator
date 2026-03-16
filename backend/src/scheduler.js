const DAY_ORDER = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];

const MAX_REQUESTED_COURSES = Number(process.env.MAX_REQUESTED_COURSES || 5);
const SEARCH_TIMEOUT_MS = Number(process.env.SCHEDULER_SEARCH_TIMEOUT_MS || 2000);
const MAX_RETURNED_ROUTINES = Number(process.env.SCHEDULER_MAX_RESULTS || 100);
const normalizedMeetingCache = new WeakMap();

function toMinutes(timeValue) {
  if (!timeValue || typeof timeValue !== "string") return null;
  const [hours, minutes] = timeValue.split(":").map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
}

function minutesOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function normalizeMeetings(section) {
  const schedule = section.sectionSchedule || {};
  const classSchedules = Array.isArray(schedule.classSchedules) ? schedule.classSchedules : [];
  const nestedLabSchedules = Array.isArray(schedule.labSchedules) ? schedule.labSchedules : [];
  const topLevelLabSchedules = Array.isArray(section.labSchedules) ? section.labSchedules : [];
  const labSchedules = [...nestedLabSchedules, ...topLevelLabSchedules];
  const meetings = [...classSchedules, ...labSchedules]
    .map((meeting) => ({
      day: String(meeting.day || "").toUpperCase(),
      startMinutes: toMinutes(meeting.startTime),
      endMinutes: toMinutes(meeting.endTime),
      startTime: meeting.startTime,
      endTime: meeting.endTime,
      source: classSchedules.includes(meeting) ? "CLASS" : "LAB",
    }))
    .filter((meeting) => {
      if (!DAY_ORDER.includes(meeting.day)) return false;
      if (meeting.startMinutes == null || meeting.endMinutes == null) return false;
      return meeting.startMinutes < meeting.endMinutes;
    });

  return meetings;
}

function getNormalizedMeetings(section) {
  if (!section || typeof section !== "object") {
    return [];
  }

  if (!normalizedMeetingCache.has(section)) {
    normalizedMeetingCache.set(section, normalizeMeetings(section));
  }

  return normalizedMeetingCache.get(section) || [];
}

function normalizeIgnoredTimeSlots(rawIgnoredTimeSlots) {
  if (!Array.isArray(rawIgnoredTimeSlots)) {
    return [];
  }

  const normalized = rawIgnoredTimeSlots
    .map((slot) => {
      const startTime = String(slot?.startTime || "");
      const endTime = String(slot?.endTime || "");
      const startMinutes = toMinutes(startTime);
      const endMinutes = toMinutes(endTime);

      if (startMinutes == null || endMinutes == null || startMinutes >= endMinutes) {
        return null;
      }

      return {
        startTime,
        endTime,
        startMinutes,
        endMinutes,
      };
    })
    .filter(Boolean);

  const deduplicated = [];
  const seenKeys = new Set();

  normalized.forEach((slot) => {
    const key = `${slot.startMinutes}-${slot.endMinutes}`;
    if (seenKeys.has(key)) {
      return;
    }

    seenKeys.add(key);
    deduplicated.push(slot);
  });

  return deduplicated;
}

function sectionFitsIgnoredTimeSlots(section, ignoredTimeSlots) {
  if (!Array.isArray(ignoredTimeSlots) || ignoredTimeSlots.length === 0) {
    return true;
  }

  const meetings = getNormalizedMeetings(section);
  for (const meeting of meetings) {
    for (const ignoredSlot of ignoredTimeSlots) {
      if (
        minutesOverlap(
          meeting.startMinutes,
          meeting.endMinutes,
          ignoredSlot.startMinutes,
          ignoredSlot.endMinutes,
        )
      ) {
        return false;
      }
    }
  }

  return true;
}

function normalizeExam(examDate, startTime, endTime) {
  if (!examDate || !startTime || !endTime) return null;
  const startMinutes = toMinutes(startTime);
  const endMinutes = toMinutes(endTime);
  if (startMinutes == null || endMinutes == null || startMinutes >= endMinutes) return null;
  return {
    date: examDate,
    startMinutes,
    endMinutes,
    startTime,
    endTime,
  };
}

function sectionMatchesFacultyPreferences(section, courseCode, facultyPreference) {
  const perCourseAvoid = facultyPreference?.avoidByCourse || {};
  const globalAvoid = facultyPreference?.avoid || [];

  const avoidForCourse = (Array.isArray(perCourseAvoid[courseCode])
    ? perCourseAvoid[courseCode]
    : globalAvoid
  ).map((value) => String(value).toUpperCase());

  const avoidSet = new Set(avoidForCourse);
  const sectionFaculty = String(section.faculties || "").toUpperCase();

  if (avoidSet.has(sectionFaculty)) {
    return false;
  }

  const perCourseMustHave = facultyPreference?.mustHaveByCourse || {};
  const globalMustHave = facultyPreference?.mustHave || [];

  const mustHaveForCourse = (Array.isArray(perCourseMustHave[courseCode])
    ? perCourseMustHave[courseCode]
    : globalMustHave
  ).map((value) => String(value).toUpperCase());

  if (mustHaveForCourse.length > 0 && !mustHaveForCourse.includes(sectionFaculty)) {
    return false;
  }

  return true;
}

function sectionFitsAllowedDays(section, allowedDays) {
  if (!Array.isArray(allowedDays) || allowedDays.length === 0) {
    return true;
  }

  const allowedDaySet = new Set(allowedDays.map((day) => String(day || "").toUpperCase()));
  const meetings = getNormalizedMeetings(section);
  return meetings.every((meeting) => allowedDaySet.has(meeting.day));
}

function sectionsConflictByClass(sectionA, sectionB) {
  const meetingsA = getNormalizedMeetings(sectionA);
  const meetingsB = getNormalizedMeetings(sectionB);

  for (const meetingA of meetingsA) {
    for (const meetingB of meetingsB) {
      if (meetingA.day !== meetingB.day) continue;
      if (
        minutesOverlap(
          meetingA.startMinutes,
          meetingA.endMinutes,
          meetingB.startMinutes,
          meetingB.endMinutes,
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

function examsConflict(sectionA, sectionB, type) {
  const scheduleA = sectionA.sectionSchedule || {};
  const scheduleB = sectionB.sectionSchedule || {};

  const examA =
    type === "MID"
      ? normalizeExam(scheduleA.midExamDate, scheduleA.midExamStartTime, scheduleA.midExamEndTime)
      : normalizeExam(scheduleA.finalExamDate, scheduleA.finalExamStartTime, scheduleA.finalExamEndTime);

  const examB =
    type === "MID"
      ? normalizeExam(scheduleB.midExamDate, scheduleB.midExamStartTime, scheduleB.midExamEndTime)
      : normalizeExam(scheduleB.finalExamDate, scheduleB.finalExamStartTime, scheduleB.finalExamEndTime);

  if (!examA || !examB) return false;
  if (examA.date !== examB.date) return false;

  return minutesOverlap(examA.startMinutes, examA.endMinutes, examB.startMinutes, examB.endMinutes);
}

function sectionsConflict(sectionA, sectionB) {
  return (
    sectionsConflictByClass(sectionA, sectionB) ||
    examsConflict(sectionA, sectionB, "MID") ||
    examsConflict(sectionA, sectionB, "FINAL")
  );
}

function buildDayUsage(selectedSections) {
  const dayToMeetings = new Map();

  selectedSections.forEach((section) => {
    const meetings = getNormalizedMeetings(section);
    meetings.forEach((meeting) => {
      if (!dayToMeetings.has(meeting.day)) {
        dayToMeetings.set(meeting.day, []);
      }
      dayToMeetings.get(meeting.day).push({
        ...meeting,
        sectionId: section.sectionId,
        courseCode: section.courseCode,
        faculty: section.faculties,
      });
    });
  });

  dayToMeetings.forEach((meetings, day) => {
    dayToMeetings.set(
      day,
      meetings.sort((a, b) => a.startMinutes - b.startMinutes),
    );
  });

  return dayToMeetings;
}

function calculateBreakPenalty(dayToMeetings, breakPreference) {
  if (!breakPreference?.enabled) return 0;

  const minBreakMinutes = 10;
  const maxBackToBackMinutes = 180;
  const penaltyWeight = 1;

  let penalty = 0;

  dayToMeetings.forEach((meetings) => {
    if (meetings.length < 2) return;

    let streakStart = meetings[0].startMinutes;
    let streakEnd = meetings[0].endMinutes;

    for (let i = 1; i < meetings.length; i += 1) {
      const current = meetings[i];
      const gap = current.startMinutes - streakEnd;

      if (gap < minBreakMinutes) {
        streakEnd = Math.max(streakEnd, current.endMinutes);
      } else {
        const streakDuration = streakEnd - streakStart;
        if (streakDuration > maxBackToBackMinutes) {
          penalty += ((streakDuration - maxBackToBackMinutes) / 60) * penaltyWeight;
        }

        streakStart = current.startMinutes;
        streakEnd = current.endMinutes;
      }
    }

    const streakDuration = streakEnd - streakStart;
    if (streakDuration > maxBackToBackMinutes) {
      penalty += ((streakDuration - maxBackToBackMinutes) / 60) * penaltyWeight;
    }
  });

  return penalty;
}

function evaluateSchedule(selectedSections, preferences) {
  const dayToMeetings = buildDayUsage(selectedSections);
  const totalDays = dayToMeetings.size;

  let totalHours = 0;
  dayToMeetings.forEach((meetings) => {
    meetings.forEach((meeting) => {
      totalHours += (meeting.endMinutes - meeting.startMinutes) / 60;
    });
  });

  const avgDailyHours = totalDays === 0 ? 0 : totalHours / totalDays;
  const breakPenalty = calculateBreakPenalty(dayToMeetings, preferences.breakPreference);

  const priority = String(preferences.priority || "MIN_DAYS").toUpperCase();
  const preferredDaysCount = Array.isArray(preferences.allowedDays) && preferences.allowedDays.length > 0
    ? preferences.allowedDays.length
    : DAY_ORDER.length;
  const dayUtilization = preferredDaysCount === 0 ? 0 : totalDays / preferredDaysCount;

  const weightedPenalty =
    (priority === "MIN_DAYS" ? totalDays * 34 : totalDays * 14) +
    (priority === "MIN_DAILY_HOURS" ? avgDailyHours * 24 : avgDailyHours * 10) +
    totalHours * 2 +
    breakPenalty * 30 +
    dayUtilization * 12;

  const score = Math.max(0, 10000 - weightedPenalty * 10);

  return {
    selectedSections,
    metrics: {
      totalDays,
      totalHours,
      avgDailyHours,
      breakPenalty,
      score,
    },
    score,
  };
}

function compareSchedulesDescending(a, b, priority) {
  if (b.score !== a.score) {
    return b.score - a.score;
  }

  if (priority === "MIN_DAILY_HOURS") {
    if (a.metrics.avgDailyHours !== b.metrics.avgDailyHours) {
      return a.metrics.avgDailyHours - b.metrics.avgDailyHours;
    }
  } else if (a.metrics.totalDays !== b.metrics.totalDays) {
    return a.metrics.totalDays - b.metrics.totalDays;
  }

  if (a.metrics.breakPenalty !== b.metrics.breakPenalty) {
    return a.metrics.breakPenalty - b.metrics.breakPenalty;
  }

  return a.metrics.totalHours - b.metrics.totalHours;
}

function getSeatNumbers(section) {
  const capacity = Number(section.capacity);
  const consumedSeat = Number(section.consumedSeat);

  const hasCapacity = Number.isFinite(capacity);
  const hasConsumed = Number.isFinite(consumedSeat);

  const normalizedCapacity = hasCapacity ? Math.max(0, capacity) : null;
  const normalizedConsumed = hasConsumed ? Math.max(0, consumedSeat) : null;

  if (normalizedCapacity == null && normalizedConsumed == null) {
    return {
      capacity: null,
      consumedSeat: null,
      remainingSeats: null,
    };
  }

  if (normalizedCapacity != null && normalizedConsumed != null) {
    return {
      capacity: normalizedCapacity,
      consumedSeat: normalizedConsumed,
      remainingSeats: Math.max(0, normalizedCapacity - normalizedConsumed),
    };
  }

  if (normalizedCapacity != null) {
    return {
      capacity: normalizedCapacity,
      consumedSeat: null,
      remainingSeats: normalizedCapacity,
    };
  }

  return {
    capacity: null,
    consumedSeat: normalizedConsumed,
    remainingSeats: null,
  };
}

function sectionPassesSeatFilter(section, ignoreFilledSections) {
  if (!ignoreFilledSections) {
    return true;
  }

  const seatNumbers = getSeatNumbers(section);
  if (seatNumbers.remainingSeats == null) {
    return true;
  }

  return seatNumbers.remainingSeats > 0;
}

function buildCandidateSectionsByCourse(courses, requestedCourseCodes, preferences) {
  const byCourse = new Map();

  requestedCourseCodes.forEach((code) => {
    byCourse.set(code, []);
  });

  courses.forEach((section) => {
    const code = String(section.courseCode || "").toUpperCase();
    if (!byCourse.has(code)) return;

    getNormalizedMeetings(section);

    if (!sectionMatchesFacultyPreferences(section, code, preferences.facultyPreference)) {
      return;
    }

    if (!sectionPassesSeatFilter(section, preferences.ignoreFilledSections)) {
      return;
    }

    if (!sectionFitsAllowedDays(section, preferences.allowedDays)) {
      return;
    }

    if (!sectionFitsIgnoredTimeSlots(section, preferences.ignoredTimeSlots)) {
      return;
    }

    byCourse.get(code).push(section);
  });

  return byCourse;
}

function canPlaceCandidate(candidate, currentSelection) {
  for (const chosen of currentSelection) {
    if (sectionsConflict(chosen, candidate)) {
      return false;
    }
  }

  return true;
}

function incrementDayCounts(dayCounts, section) {
  const meetings = getNormalizedMeetings(section);
  meetings.forEach((meeting) => {
    dayCounts.set(meeting.day, (dayCounts.get(meeting.day) || 0) + 1);
  });
}

function decrementDayCounts(dayCounts, section) {
  const meetings = getNormalizedMeetings(section);
  meetings.forEach((meeting) => {
    const nextValue = (dayCounts.get(meeting.day) || 0) - 1;
    if (nextValue <= 0) {
      dayCounts.delete(meeting.day);
    } else {
      dayCounts.set(meeting.day, nextValue);
    }
  });
}

function wouldExceedMaxDays(dayCounts, section, maxDaysPerWeek) {
  if (!maxDaysPerWeek || maxDaysPerWeek <= 0) {
    return false;
  }

  const addedDays = new Set(getNormalizedMeetings(section).map((meeting) => meeting.day));
  let projectedSize = dayCounts.size;
  addedDays.forEach((day) => {
    if (!dayCounts.has(day)) projectedSize += 1;
  });

  return projectedSize > maxDaysPerWeek;
}

function hasFeasibleCandidate(candidates, currentSelection, dayCounts, maxDaysPerWeek) {
  for (const candidate of candidates) {
    if (!canPlaceCandidate(candidate, currentSelection)) {
      continue;
    }

    if (wouldExceedMaxDays(dayCounts, candidate, maxDaysPerWeek)) {
      continue;
    }

    return true;
  }

  return false;
}

function shuffleCopy(input) {
  const copy = [...input];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildApproximateSchedules(orderedCourseCodes, candidatesByCourse, preferences, limit) {
  const maxAttempts = 64;
  const foundSchedules = [];

  for (let attempt = 0; attempt < maxAttempts && foundSchedules.length < limit; attempt += 1) {
    const currentSelection = [];
    const dayCounts = new Map();
    let failed = false;

    for (const courseCode of orderedCourseCodes) {
      const candidates = shuffleCopy(candidatesByCourse.get(courseCode) || []);
      let chosen = null;

      for (const candidate of candidates) {
        if (!canPlaceCandidate(candidate, currentSelection)) {
          continue;
        }

        if (wouldExceedMaxDays(dayCounts, candidate, preferences.maxDaysPerWeek)) {
          continue;
        }

        chosen = candidate;
        break;
      }

      if (!chosen) {
        failed = true;
        break;
      }

      currentSelection.push(chosen);
      incrementDayCounts(dayCounts, chosen);
    }

    if (failed) {
      continue;
    }

    foundSchedules.push(evaluateSchedule(currentSelection, preferences));
  }

  return foundSchedules;
}

function serializeSection(section) {
  const schedule = section.sectionSchedule || {};
  const nestedLabSchedules = Array.isArray(schedule.labSchedules) ? schedule.labSchedules : [];
  const topLevelLabSchedules = Array.isArray(section.labSchedules) ? section.labSchedules : [];
  const seatNumbers = getSeatNumbers(section);
  return {
    sectionId: section.sectionId,
    sectionName:
      section.sectionName ||
      section.section ||
      section.classSection ||
      `Section ${section.sectionId}`,
    courseCode: section.courseCode,
    faculties: section.faculties,
    capacity: seatNumbers.capacity,
    consumedSeat: seatNumbers.consumedSeat,
    remainingSeats: seatNumbers.remainingSeats,
    sectionSchedule: {
      finalExamDate: schedule.finalExamDate,
      finalExamStartTime: schedule.finalExamStartTime,
      finalExamEndTime: schedule.finalExamEndTime,
      midExamDate: schedule.midExamDate,
      midExamStartTime: schedule.midExamStartTime,
      midExamEndTime: schedule.midExamEndTime,
      classSchedules: Array.isArray(schedule.classSchedules) ? schedule.classSchedules : [],
      labSchedules: [...nestedLabSchedules, ...topLevelLabSchedules],
    },
  };
}

function calculateTotalCombinations(orderedCourseCodes, candidatesByCourse) {
  let total = 1n;

  orderedCourseCodes.forEach((courseCode) => {
    const count = BigInt((candidatesByCourse.get(courseCode) || []).length);
    total *= count;
  });

  return total;
}

function serializeBigIntCount(value) {
  if (value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }

  return value.toString();
}

function generateRoutines(catalogCourses, requestedCourseCodes, rawPreferences = {}) {
  const normalizedRequestedCodes = (requestedCourseCodes || [])
    .map((code) => String(code || "").toUpperCase().trim())
    .filter(Boolean);

  if (normalizedRequestedCodes.length === 0) {
    throw new Error("At least one course code is required.");
  }

  const uniqueRequestedCodes = [...new Set(normalizedRequestedCodes)];

  if (uniqueRequestedCodes.length > MAX_REQUESTED_COURSES) {
    throw new Error(
      `A maximum of ${MAX_REQUESTED_COURSES} courses can be requested at once. Please reduce your selection.`,
    );
  }

  const preferences = {
    maxDaysPerWeek: Number(rawPreferences.maxDaysPerWeek || 0),
    allowedDays: Array.isArray(rawPreferences.allowedDays)
      ? rawPreferences.allowedDays.map((day) => String(day || "").toUpperCase()).filter(Boolean)
      : [],
    facultyPreference: rawPreferences.facultyPreference || {},
    breakPreference: rawPreferences.breakPreference || {},
    ignoredTimeSlots: normalizeIgnoredTimeSlots(rawPreferences.ignoredTimeSlots),
    ignoreFilledSections: rawPreferences.ignoreFilledSections !== false,
    priority: rawPreferences.priority || "MIN_DAYS",
  };

  const candidatesByCourse = buildCandidateSectionsByCourse(
    catalogCourses,
    uniqueRequestedCodes,
    preferences,
  );

  for (const code of uniqueRequestedCodes) {
    if (!candidatesByCourse.has(code) || candidatesByCourse.get(code).length === 0) {
      throw new Error("Cannot generate schedule with these constraints");
    }
  }

  const orderedCourseCodes = [...uniqueRequestedCodes].sort(
    (a, b) => candidatesByCourse.get(a).length - candidatesByCourse.get(b).length,
  );

  const validSchedules = [];
  const startedAt = Date.now();
  const totalCombinations = calculateTotalCombinations(orderedCourseCodes, candidatesByCourse);
  const searchState = {
    timedOut: false,
    reachedResultCap: false,
    exploredLeafCount: 0,
  };

  function dfs(courseIndex, currentSelection, dayCounts) {
    if (searchState.timedOut || searchState.reachedResultCap) {
      return;
    }

    if (Date.now() - startedAt >= SEARCH_TIMEOUT_MS) {
      searchState.timedOut = true;
      return;
    }

    if (courseIndex === orderedCourseCodes.length) {
      searchState.exploredLeafCount += 1;
      validSchedules.push(evaluateSchedule([...currentSelection], preferences));
      if (validSchedules.length >= MAX_RETURNED_ROUTINES) {
        searchState.reachedResultCap = true;
      }
      return;
    }

    const courseCode = orderedCourseCodes[courseIndex];
    const candidates = candidatesByCourse.get(courseCode) || [];

    for (const candidate of candidates) {
      if (!canPlaceCandidate(candidate, currentSelection)) {
        continue;
      }

      if (wouldExceedMaxDays(dayCounts, candidate, preferences.maxDaysPerWeek)) {
        continue;
      }

      currentSelection.push(candidate);
      incrementDayCounts(dayCounts, candidate);

      if (courseIndex + 1 < orderedCourseCodes.length) {
        const nextCourseCode = orderedCourseCodes[courseIndex + 1];
        const nextCandidates = candidatesByCourse.get(nextCourseCode) || [];
        if (!hasFeasibleCandidate(nextCandidates, currentSelection, dayCounts, preferences.maxDaysPerWeek)) {
          decrementDayCounts(dayCounts, candidate);
          currentSelection.pop();
          continue;
        }
      }

      dfs(courseIndex + 1, currentSelection, dayCounts);

      decrementDayCounts(dayCounts, candidate);
      currentSelection.pop();

      if (searchState.timedOut || searchState.reachedResultCap) {
        return;
      }
    }
  }

  dfs(0, [], new Map());

  if (validSchedules.length === 0 && searchState.timedOut) {
    validSchedules.push(...buildApproximateSchedules(
      orderedCourseCodes,
      candidatesByCourse,
      preferences,
      MAX_RETURNED_ROUTINES,
    ));
  }

  if (validSchedules.length === 0) {
    throw new Error("Cannot generate schedule with these constraints");
  }

  validSchedules.sort((a, b) =>
    compareSchedulesDescending(a, b, String(preferences.priority || "MIN_DAYS").toUpperCase()),
  );

  const routines = validSchedules.map((schedule) => ({
    sections: schedule.selectedSections.map(serializeSection),
    metrics: schedule.metrics,
  }));

  return {
    routines,
    stats: {
      totalCombinations: serializeBigIntCount(totalCombinations),
      generatedRoutines: routines.length,
      exploredLeafCount: searchState.exploredLeafCount,
      timedOut: searchState.timedOut,
      reachedResultCap: searchState.reachedResultCap,
    },
  };
}

module.exports = {
  DAY_ORDER,
  generateRoutines,
  MAX_REQUESTED_COURSES,
  toMinutes,
};
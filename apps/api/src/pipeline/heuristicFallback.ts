import { randomUUID } from "node:crypto";
import type { ExtractedSections } from "./extraction.js";
import type {
  Appointment,
  Explanation,
  Medication,
  OcrLine,
  OcrResult,
  TimelineEntry,
  Warning,
} from "./types.js";

export const FALLBACK_CONFIDENCE = 65;

interface NumberedLine {
  line: number;
  text: string;
}

function formatLine(line: OcrLine): string {
  return `${line.line}: ${line.text}`;
}

function lower(text: string): string {
  return text.toLowerCase();
}

function includesAny(text: string, needles: string[]): boolean {
  const haystack = lower(text);
  return needles.some((needle) => haystack.includes(needle));
}

function titleCase(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\w\S*/g, (word) =>
      word.length <= 3 && word === word.toUpperCase()
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
    );
}

function uniquePush(map: Map<number, string>, line: OcrLine): void {
  if (!map.has(line.line)) map.set(line.line, formatLine(line));
}

function joinBucket(bucket: Map<number, string>): string {
  return [...bucket.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, text]) => text)
    .join("\n");
}

export function fallbackExtractedSections(ocr: OcrResult): ExtractedSections {
  const buckets = {
    medicationsText: new Map<number, string>(),
    appointmentsText: new Map<number, string>(),
    warningsText: new Map<number, string>(),
    timelineText: new Map<number, string>(),
    otherText: new Map<number, string>(),
  };

  for (const line of ocr.lines) {
    const text = lower(line.text);
    let matched = false;

    if (
      includesAny(text, [
        "medication",
        "antibiotic",
        "tablet",
        "capsule",
        "dose",
        "mg",
      ])
    ) {
      uniquePush(buckets.medicationsText, line);
      matched = true;
    }

    if (
      includesAny(text, [
        "follow-up",
        "follow up",
        "appointment",
        "primary care",
        "clinic",
        "physical therapy",
      ])
    ) {
      uniquePush(buckets.appointmentsText, line);
      uniquePush(buckets.timelineText, line);
      matched = true;
    }

    if (
      includesAny(text, [
        "urgent care",
        "emergency",
        "call 911",
        "seek help",
        "warning sign",
        "return precautions",
        "shortness of breath",
        "chest pain",
        "persistent fever",
        "confusion",
        "oxygen saturation",
      ])
    ) {
      uniquePush(buckets.warningsText, line);
      matched = true;
    }

    if (
      includesAny(text, [
        "complete prescribed",
        "stay hydrated",
        "walk",
        "breathing exercises",
        "monitor temperature",
        "monitor symptoms",
        "strenuous activity",
        "until cleared",
        "take medications",
        "do:",
        "don't:",
      ])
    ) {
      uniquePush(buckets.timelineText, line);
      matched = true;
    }

    if (!matched) uniquePush(buckets.otherText, line);
  }

  return {
    medicationsText: joinBucket(buckets.medicationsText),
    appointmentsText: joinBucket(buckets.appointmentsText),
    warningsText: joinBucket(buckets.warningsText),
    timelineText: joinBucket(buckets.timelineText),
    otherText: joinBucket(buckets.otherText),
  };
}

function parseNumberedLines(text: string): NumberedLine[] {
  return text
    .split(/\r?\n/)
    .map((raw, index) => {
      const match = raw.match(/^\s*(\d+):\s*(.*)$/);
      return {
        line: match ? Number(match[1]) : index + 1,
        text: (match ? match[2] : raw).trim(),
      };
    })
    .filter((line) => line.text.length > 0);
}

function sourceLinesFromText(sectionText: string, fullOcr: OcrResult) {
  const byLine = new Map(fullOcr.lines.map((line) => [line.line, line]));
  return parseNumberedLines(sectionText).filter((line) =>
    byLine.has(line.line),
  );
}

function fallbackOverall<T extends { confidence: number }>(items: T[]): number {
  if (items.length === 0) return FALLBACK_CONFIDENCE;
  return Math.round(
    items.reduce((sum, item) => sum + item.confidence, 0) / items.length,
  );
}

function cleanInstruction(text: string): string {
  return text
    .replace(/^\s*\d+\.\s*/, "")
    .replace(/^[\s:;,.(-]+|[\s:;,.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFrequency(text: string): string {
  const patterns = [
    /\bevery\s+\d+\s+hours?(?:\s+as needed)?\b/i,
    /\bthree\s+times(?:\s+a)?\s+day\b/i,
    /\bthree\s+times\s+daily\b/i,
    /\btwice\s+daily\b/i,
    /\btwo\s+times(?:\s+a)?\s+day\b/i,
    /\bonce\s+daily\b/i,
    /\bdaily\b/i,
    /\beach\s+morning\b/i,
    /\bas\s+needed\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return "";
}

function extractTiming(text: string): string {
  const patterns = [
    /\bwith\s+food\b/i,
    /\bbefore\s+meals?\b/i,
    /\bafter\s+meals?\b/i,
    /\bat\s+bedtime\b/i,
    /\beach\s+morning\b/i,
    /\bin\s+the\s+morning\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return "";
}

/**
 * Drops the instruction verb a medication line usually opens with.
 *
 * The name pattern starts at a capital letter, so "Take Lisinopril 10mg" put
 * "Take Lisinopril" in the name field — which then rendered as "Take Take
 * Lisinopril" once the timeline prefixed its own verb. Only strips when a real
 * name follows, so a drug legitimately called "Take..." isn't mangled away.
 */
function stripLeadingVerb(name: string): string {
  const stripped = name.replace(
    /^(take|takes|taking|continue|start|begin|stop|use|apply|inject|give|administer|resume|swallow)\s+/i,
    "",
  );
  return stripped.trim().length >= 3 ? stripped.trim() : name;
}

export function fallbackMedications(
  medicationsText: string,
  fullOcr: OcrResult,
): Medication[] {
  const candidates = sourceLinesFromText(medicationsText, fullOcr);
  const seen = new Set<string>();
  const medications: Medication[] = [];

  for (const line of candidates) {
    const text = cleanInstruction(line.text);
    if (/take medications as directed/i.test(text)) continue;
    if (/prescribed antibiotics/i.test(text) && !/\d/.test(text)) continue;

    const match = text.match(
      /^(?:[-*]\s*)?(?:\d+\.\s*)?(?<name>[A-Z][A-Za-z0-9' -]{1,60}?)\s+(?<dose>\d+(?:\.\d+)?\s*(?:mg|mcg|g|ml|mL|units?|iu|puffs?|tablets?|tabs?|capsules?|caps?)(?:\s+(?:tablets?|tabs?|capsules?|caps?|pills?|puffs?|sprays?|patch(?:es)?|drops?|injections?|doses?|suppositor(?:y|ies)))?)(?<rest>.*)$/i,
    );
    if (!match?.groups) continue;

    const name = stripLeadingVerb(cleanInstruction(match.groups.name ?? ""));
    const dose = cleanInstruction(match.groups.dose ?? "");
    const rest = cleanInstruction(match.groups.rest ?? "");
    if (!name || !dose) continue;

    const key = `${lower(name)}:${lower(dose)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    medications.push({
      id: randomUUID(),
      name,
      dose,
      frequency: extractFrequency(rest),
      timing: extractTiming(rest),
      instructions: rest,
      sourceLines: [line.line],
      confidence: FALLBACK_CONFIDENCE,
    });
  }

  return medications;
}

function isoDateFromText(text: string): string | null {
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return iso[0];

  const slash = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (!slash) return null;
  const month = slash[1]!.padStart(2, "0");
  const day = slash[2]!.padStart(2, "0");
  const rawYear = slash[3]!;
  const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
  return `${year}-${month}-${day}`;
}

function dateTextFromText(text: string): string {
  const relative = text.match(
    /\b(?:in|within)\s+\d+\s+(?:day|days|week|weeks|month|months)\b/i,
  );
  if (relative) return relative[0];

  const concrete = text.match(
    /\b\d{1,2}\/\d{1,2}\/\d{2,4}(?:\s+at\s+[^,.;]+)?/i,
  );
  if (concrete) return concrete[0];

  return "";
}

function doctorFromText(text: string): string {
  const match = text.match(
    /\bDr\.?\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})/,
  );
  return match ? `Dr. ${match[1]}` : "";
}

function specialtyFromText(text: string): string {
  const patterns: Array<[RegExp, string]> = [
    [/\bprimary care\b/i, "Primary care"],
    [/\bpcp\b/i, "Primary care"],
    [/\borthopedic\b/i, "Orthopedics"],
    [/\bphysical therapy\b/i, "Physical therapy"],
    [/\bsurgery\b|\bsurgeon\b/i, "Surgery"],
    [/\bcardiology\b/i, "Cardiology"],
    [/\bpulmonology\b|\blung\b/i, "Pulmonology"],
  ];
  for (const [pattern, specialty] of patterns) {
    if (pattern.test(text)) return specialty;
  }

  const follow = text.match(
    /follow[- ]?up(?: appointment)?(?: with)?\s+([^.;,]+)/i,
  );
  if (follow?.[1]) return titleCase(follow[1].replace(/\bin\b.*$/i, ""));
  return "";
}

function locationFromText(text: string): string {
  const match = text.match(
    /\b(?:at|,)\s+([^.;]*(?:clinic|associates|therapy|hospital|center|drive|suite)[^.;]*)/i,
  );
  return match ? cleanInstruction(match[1] ?? "") : "";
}

export function fallbackAppointments(
  appointmentsText: string,
  fullOcr: OcrResult,
): Appointment[] {
  const candidates = sourceLinesFromText(appointmentsText, fullOcr);
  const seen = new Set<string>();
  const appointments: Appointment[] = [];

  for (const line of candidates) {
    const original = cleanInstruction(line.text);
    const isAppointmentLine =
      /(follow[- ]?up|appointment|clinic|primary care|doctor|provider|surgeon)/i.test(
        original,
      ) ||
      (/\btherapy\b/i.test(original) &&
        /\b(evaluation|follow[- ]?up|appointment|in\s+\d+|on\s+\d|Dr\.?)/i.test(
          original,
        ));
    if (!isAppointmentLine) {
      continue;
    }

    const doctor = doctorFromText(original);
    const specialty = specialtyFromText(original);
    const date = isoDateFromText(original);
    const dateText = dateTextFromText(original);
    const location = locationFromText(original);
    if (
      !doctor &&
      !date &&
      !dateText &&
      (!specialty || /^appointments?$/i.test(specialty))
    ) {
      continue;
    }
    const key = `${line.line}:${doctor}:${specialty}:${date ?? dateText}`;
    if (seen.has(key)) continue;
    seen.add(key);

    appointments.push({
      id: randomUUID(),
      date,
      dateText,
      doctor,
      specialty,
      location,
      notes: original,
      sourceLines: [line.line],
      confidence: FALLBACK_CONFIDENCE,
    });
  }

  return appointments;
}

function windowFromLine(
  ocr: OcrResult,
  index: number,
  maxNext = 2,
): NumberedLine {
  const window = ocr.lines.slice(index, index + maxNext + 1);
  return {
    line: ocr.lines[index]!.line,
    text: window.map((line) => line.text.trim()).join(" "),
  };
}

function windowSourceLines(
  ocr: OcrResult,
  startLine: number,
  maxNext = 2,
): number[] {
  const index = ocr.lines.findIndex((line) => line.line === startLine);
  if (index === -1) return [startLine];
  return ocr.lines.slice(index, index + maxNext + 1).map((line) => line.line);
}

function warningAction(text: string): Pick<Warning, "action" | "severity"> {
  if (/\b911\b/i.test(text)) {
    return { action: "Call 911", severity: "emergency" };
  }
  if (/\b(emergency|urgent care|er)\b/i.test(text)) {
    return { action: "Seek urgent care", severity: "emergency" };
  }
  return { action: "Call your provider", severity: "call-doctor" };
}

function warningSymptoms(text: string): string[] {
  // Built from the same source as the gate above. These were two hand-kept
  // lists and they drifted: the gate let "call your doctor if…" through, then
  // this one dropped it because it only accepted "call the doctor", so the
  // warning vanished between the two.
  const match = text.match(
    new RegExp(
      `(?:${EMERGENCY_PHRASING_SOURCE})[^.]*?\\b(?:for|if|when|with)\\b\\s+(.+)`,
      "i",
    ),
  );
  const after = match?.[1] ?? "";
  if (!after.trim()) return [];
  const firstSentence = after.split(/[.]/)[0] ?? after;
  return firstSentence
    .replace(/\bor\b/gi, ",")
    .replace(/\band\b/gi, ",")
    .split(/[,;]/)
    .map(cleanInstruction)
    .filter((symptom) => symptom.length >= 4)
    .filter((symptom) => !/^(a|an|the|your|their)$/i.test(symptom));
}

/**
 * Phrasings that mean "this is an emergency" in a discharge document.
 *
 * Discharge paperwork says "go to the ER" far more often than "emergency room",
 * and the earlier pattern only matched the spelled-out form — so the single most
 * common way of writing it was dropped silently. A missed red flag is the worst
 * failure this pipeline has, so abbreviations, non-US emergency numbers, and
 * "return to hospital" are matched explicitly. The \b guards stop "er"/"ed"
 * firing inside ordinary words, and the longer alternatives are listed first so
 * "emergency room" isn't shadowed.
 *
 * Kept as a source string because `warningSymptoms` needs the same list with a
 * suffix appended; two hand-maintained copies is exactly how the gap appeared.
 */
const EMERGENCY_PHRASING_SOURCE =
  "seek\\b|urgent care|go (?:back |straight )?to (?:the )?(?:emergency room|emergency department|emergency|hospital|er|ed)\\b|return to (?:the )?(?:emergency room|emergency department|emergency|hospital|er|ed)\\b|emergency (?:room|department|services)|call (?:911|999|112)\\b|call (?:the |your |their )?(?:clinic|doctor|provider|surgeon|nurse|office)";

const EMERGENCY_PHRASING = new RegExp(`(?:${EMERGENCY_PHRASING_SOURCE})`, "i");

export function fallbackWarnings(
  _warningsText: string,
  fullOcr: OcrResult,
): Warning[] {
  const warnings: Warning[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < fullOcr.lines.length; index += 1) {
    const line = fullOcr.lines[index]!;
    if (!EMERGENCY_PHRASING.test(line.text)) {
      continue;
    }

    const window = windowFromLine(fullOcr, index);
    if (!EMERGENCY_PHRASING.test(window.text)) {
      continue;
    }

    const { action, severity } = warningAction(window.text);
    for (const symptom of warningSymptoms(window.text)) {
      const key = lower(symptom);
      if (seen.has(key)) continue;
      seen.add(key);
      warnings.push({
        id: randomUUID(),
        symptom,
        action,
        severity,
        sourceLines: windowSourceLines(fullOcr, line.line),
        confidence: FALLBACK_CONFIDENCE,
      });
    }
  }

  return warnings;
}

function addTimeline(
  items: TimelineEntry[],
  seen: Set<string>,
  entry: Omit<TimelineEntry, "id" | "confidence">,
): void {
  const key = lower(`${entry.bucket}:${entry.title}:${entry.detail}`);
  if (seen.has(key)) return;
  seen.add(key);
  items.push({
    ...entry,
    id: randomUUID(),
    confidence: FALLBACK_CONFIDENCE,
  });
}

export function fallbackTimeline(
  _timelineText: string,
  context: { medications: Medication[]; appointments: Appointment[] },
  fullOcr?: OcrResult,
): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];
  const seen = new Set<string>();

  for (const medication of context.medications) {
    addTimeline(timeline, seen, {
      bucket: "today",
      title: `Take ${medication.name}`,
      detail: [medication.dose, medication.frequency, medication.timing]
        .filter(Boolean)
        .join(", "),
      sourceLines: medication.sourceLines,
    });
  }

  for (const appointment of context.appointments) {
    addTimeline(timeline, seen, {
      bucket: appointment.date ? "later" : "this-week",
      title: "Attend follow-up appointment",
      detail: [appointment.specialty, appointment.doctor, appointment.dateText]
        .filter(Boolean)
        .join(" - "),
      sourceLines: appointment.sourceLines,
    });
  }

  if (!fullOcr) return timeline;

  for (const line of fullOcr.lines) {
    const text = lower(line.text);
    const sourceLines = [line.line];
    if (text.includes("complete prescribed antibiotics")) {
      addTimeline(timeline, seen, {
        bucket: "this-week",
        title: "Complete prescribed antibiotics",
        detail: "Finish the antibiotic course exactly as directed.",
        sourceLines,
      });
    }
    if (text.includes("stay hydrated")) {
      addTimeline(timeline, seen, {
        bucket: "today",
        title: "Stay hydrated",
        detail: "Drink fluids as your care team directed.",
        sourceLines,
      });
    }
    if (/\bwalk\b/.test(text)) {
      addTimeline(timeline, seen, {
        bucket: "today",
        title: "Walk as tolerated",
        detail: "Walk several times daily if you can do so safely.",
        sourceLines,
      });
    }
    if (text.includes("breathing exercises")) {
      addTimeline(timeline, seen, {
        bucket: "today",
        title: "Practice breathing exercises",
        detail: "Use the breathing exercises from the discharge instructions.",
        sourceLines,
      });
    }
    if (
      text.includes("monitor temperature") ||
      text.includes("monitor symptoms")
    ) {
      addTimeline(timeline, seen, {
        bucket: "today",
        title: "Monitor symptoms",
        detail: "Track temperature and symptoms and follow return precautions.",
        sourceLines,
      });
    }
    if (text.includes("strenuous activity") && text.includes("cleared")) {
      addTimeline(timeline, seen, {
        bucket: "this-week",
        title: "Avoid strenuous activity",
        detail: "Wait until your clinician clears you.",
        sourceLines,
      });
    }
    if (/\bdon'?t:\s*smoke\b/i.test(line.text)) {
      addTimeline(timeline, seen, {
        bucket: "this-week",
        title: "Avoid smoking",
        detail: "Do not smoke during recovery.",
        sourceLines,
      });
    }
  }

  return timeline;
}

const EXPLANATION_TERMS: Array<{
  term: string;
  pattern: RegExp;
  plainText: string;
}> = [
  {
    term: "community-acquired pneumonia",
    pattern: /\bcommunity-acquired pneumonia\b/i,
    plainText:
      "A lung infection that started outside the hospital. It can make breathing harder while the infection clears.",
  },
  {
    term: "hypoxemia",
    pattern: /\bhypoxemia\b/i,
    plainText:
      "A lower-than-normal oxygen level in the blood. Doctors monitor it because your organs need enough oxygen to work well.",
  },
  {
    term: "bronchodilators",
    pattern: /\bbronchodilators?\b/i,
    plainText:
      "Medicines that help open the airways in the lungs, which can make breathing easier.",
  },
  {
    term: "oxygen saturation",
    pattern: /\boxygen\s+saturation\b/i,
    plainText:
      "A measure of how much oxygen your blood is carrying. Low readings can mean you need urgent medical advice.",
  },
  {
    term: "teach-back",
    pattern: /\bteach-back\b/i,
    plainText:
      "A safety check where the patient repeats instructions in their own words to confirm they understood them.",
  },
  {
    term: "IV antibiotics",
    pattern: /\bIV antibiotics\b/i,
    plainText:
      "Antibiotic medicine given through a vein, usually when the infection needs stronger or faster treatment.",
  },
  {
    term: "ORIF",
    pattern: /\bORIF\b|open reduction and internal fixation/i,
    plainText:
      "A surgery to put broken bones back in place and hold them there with hardware like screws or plates.",
  },
  {
    term: "femoral neck",
    pattern: /\bfemoral neck\b/i,
    plainText: "The narrow part of the thigh bone just below the hip joint.",
  },
];

function explanationSourceLines(ocr: OcrResult, pattern: RegExp): number[] {
  const direct = ocr.lines
    .filter((line) => pattern.test(line.text))
    .map((line) => line.line);
  if (direct.length > 0) return direct;

  for (let index = 0; index < ocr.lines.length; index += 1) {
    const window = windowFromLine(ocr, index, 1);
    if (pattern.test(window.text)) {
      return windowSourceLines(ocr, ocr.lines[index]!.line, 1);
    }
  }
  return [];
}

export function fallbackExplanations(ocr: OcrResult): Explanation[] {
  const explanations: Explanation[] = [];

  for (const definition of EXPLANATION_TERMS) {
    const sourceLines = explanationSourceLines(ocr, definition.pattern);
    if (sourceLines.length === 0) continue;

    explanations.push({
      id: randomUUID(),
      term: definition.term,
      plainText: definition.plainText,
      sourceLines,
      confidence: FALLBACK_CONFIDENCE,
    });
  }

  return explanations;
}

export const fallbackConfidence = fallbackOverall;

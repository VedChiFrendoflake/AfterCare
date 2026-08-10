import { describe, expect, it } from "vitest";
import { fallbackMedications } from "../../src/pipeline/heuristicFallback.js";
import type { OcrResult } from "../../src/pipeline/types.js";

function ocrOf(...lines: string[]): OcrResult {
  return {
    lines: lines.map((text, index) => ({ line: index + 1, text, confidence: 99 })),
    text: lines.join("\n"),
    pageCount: 1,
  };
}

function parse(line: string) {
  const ocr = ocrOf(line);
  return fallbackMedications(`1: ${line}`, ocr)[0];
}

/**
 * The dose pattern used to end in an open `(?:\s+[A-Za-z]+)?`, which absorbed
 * whichever word came next. That turned "10mg once daily" into a dose of
 * "10mg once" and a frequency of "daily", so the card read "10mg once · daily".
 */
describe("medication parsing", () => {
  it("keeps schedule words out of the dose", () => {
    const med = parse("Take Lisinopril 10mg once daily in the morning.");
    expect(med?.name).toBe("Lisinopril");
    expect(med?.dose).toBe("10mg");
    expect(med?.frequency).toBe("once daily");
    expect(med?.timing).toBe("in the morning");
  });

  it("handles an as-needed schedule without mangling the dose", () => {
    const med = parse("Take Ibuprofen 400mg every 6 hours as needed for pain.");
    expect(med?.dose).toBe("400mg");
    expect(med?.frequency).toBe("every 6 hours as needed");
  });

  it("reads a twice-daily line", () => {
    const med = parse("Take Metformin 500mg twice daily with food.");
    expect(med?.name).toBe("Metformin");
    expect(med?.dose).toBe("500mg");
    expect(med?.frequency).toBe("twice daily");
    expect(med?.timing).toBe("with food");
  });

  it("still keeps a genuine dosage form attached to the dose", () => {
    // "capsule" describes the dose; "three times a day" does not.
    const med = parse("Amoxicillin 500 mg capsule three times a day");
    expect(med?.dose).toBe("500 mg capsule");
    expect(med?.frequency).toBe("three times a day");
  });

  it("drops the instruction verb from the drug name", () => {
    expect(parse("Continue Metformin 500mg twice daily")?.name).toBe("Metformin");
    expect(parse("Lisinopril 10mg daily")?.name).toBe("Lisinopril");
  });
});

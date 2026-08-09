import { describe, expect, it } from "vitest";
import { fallbackWarnings } from "../../src/pipeline/heuristicFallback.js";
import type { OcrResult } from "../../src/pipeline/types.js";

function ocrOf(...lines: string[]): OcrResult {
  return {
    lines: lines.map((text, index) => ({
      line: index + 1,
      text,
      confidence: 99,
    })),
    text: lines.join("\n"),
    pageCount: 1,
  };
}

/**
 * When AI extraction is unavailable the heuristic fallback is the only thing
 * standing between a patient and a missed red flag, so the phrasings real
 * discharge paperwork actually uses have to be covered. "Go to the ER" was
 * silently dropped once; these pin the behaviour down.
 */
describe("fallbackWarnings emergency phrasing", () => {
  const phrasings = [
    "Go to the ER if you have chest pain or trouble breathing.",
    "Go to the emergency room if you develop a fever over 101F.",
    "Return to the emergency department if the bleeding does not stop.",
    "Call 911 if you have sudden weakness or slurred speech.",
    "Seek urgent care if the swelling gets worse.",
    "Go back to the hospital if you cannot keep fluids down.",
    "Call your doctor if the incision becomes red or warm.",
  ];

  for (const text of phrasings) {
    it(`detects a warning in: "${text}"`, () => {
      const warnings = fallbackWarnings(text, ocrOf(text));
      expect(warnings.length).toBeGreaterThan(0);
    });
  }

  it("does not fire on ordinary discharge prose", () => {
    const benign = ocrOf(
      "Take Lisinopril 10mg once daily in the morning.",
      "Your surgeon recommended rest for two weeks.",
      "Remember to bring this paperwork to your next visit.",
    );
    expect(fallbackWarnings(benign.text, benign)).toHaveLength(0);
  });

  it("does not match 'er' or 'ed' inside ordinary words", () => {
    const benign = ocrOf(
      "You may feel tired or watered down for several days.",
      "The wound was cleaned and covered before you left.",
    );
    expect(fallbackWarnings(benign.text, benign)).toHaveLength(0);
  });
});

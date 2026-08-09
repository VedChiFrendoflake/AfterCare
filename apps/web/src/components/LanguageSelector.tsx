import { useEffect, useState } from "react";

/**
 * Page translation via Google Translate.
 *
 * Two decisions worth knowing about:
 *
 * 1. The language is applied by setting Google's `googtrans` cookie and
 *    reloading, rather than by driving the widget's own <select> at runtime.
 *    The widget works by rewriting text nodes in place, and React keeps
 *    references to those same nodes — mutating them mid-session throws
 *    NotFoundError from removeChild on the next render. Reloading means the
 *    translation is applied once, before React mounts, and never fights it.
 *
 * 2. Anything carrying a clinical value is marked `notranslate` at the point it
 *    is rendered. Machine translation of "take 2 tablets every 6 hours" can
 *    move a number or drop a negation, and this app's whole promise is that it
 *    never alters a dose, schedule, or warning. Explanatory prose is
 *    translated; the values themselves stay verbatim, as printed.
 */

export interface Language {
  code: string;
  label: string;
  /** Endonym — shown so a speaker can find their language without reading English. */
  native: string;
}

// Deliberately short: the languages most likely to be needed at a US hospital
// discharge, rather than every language Google offers in a 100-item dropdown.
export const LANGUAGES: Language[] = [
  { code: "en", label: "English", native: "English" },
  { code: "es", label: "Spanish", native: "Español" },
  { code: "zh-CN", label: "Chinese (Simplified)", native: "简体中文" },
  { code: "tl", label: "Tagalog", native: "Tagalog" },
  { code: "vi", label: "Vietnamese", native: "Tiếng Việt" },
  { code: "ar", label: "Arabic", native: "العربية" },
  { code: "fr", label: "French", native: "Français" },
  { code: "ru", label: "Russian", native: "Русский" },
  { code: "pt", label: "Portuguese", native: "Português" },
  { code: "ko", label: "Korean", native: "한국어" },
  { code: "hi", label: "Hindi", native: "हिन्दी" },
];

const COOKIE = "googtrans";

/** Reads the language Google is currently applying, e.g. "/en/es" -> "es". */
export function currentLanguage(): string {
  const match = document.cookie.match(/(?:^|;\s*)googtrans=([^;]*)/);
  if (!match) return "en";
  const value = decodeURIComponent(match[1] ?? "");
  const target = value.split("/")[2];
  return target && target.length > 0 ? target : "en";
}

function setLanguage(code: string): void {
  // Google reads this cookie on both the bare host and the dot-prefixed domain
  // depending on how the page is served, so clear and set both. Without the
  // domain-scoped copy the choice silently fails to stick on *.vercel.app.
  const host = window.location.hostname;
  const expire = "expires=Thu, 01 Jan 1970 00:00:00 GMT";
  for (const domain of ["", `; domain=${host}`, `; domain=.${host}`]) {
    document.cookie = `${COOKIE}=; path=/${domain}; ${expire}`;
  }

  if (code !== "en") {
    const value = `/en/${code}`;
    document.cookie = `${COOKIE}=${value}; path=/`;
    document.cookie = `${COOKIE}=${value}; path=/; domain=.${host}`;
  }

  window.location.reload();
}

export function LanguageSelector() {
  const [value, setValue] = useState("en");

  useEffect(() => {
    setValue(currentLanguage());
  }, []);

  return (
    <div className="lang-select notranslate" translate="no">
      <i className="ph-duotone ph-translate" aria-hidden="true" />
      <label className="sr-only" htmlFor="lang-select">
        Choose a language
      </label>
      <select
        id="lang-select"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setLanguage(event.target.value);
        }}
      >
        {LANGUAGES.map((language) => (
          <option key={language.code} value={language.code}>
            {language.native}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Shown once the page is being machine-translated. The point is not decoration:
 * the reader needs to know a machine moved between them and their discharge
 * instructions, and that the printed values are the authority.
 */
export function TranslationNotice() {
  const [language, setLanguageState] = useState("en");

  useEffect(() => {
    setLanguageState(currentLanguage());
  }, []);

  if (language === "en") return null;

  const name =
    LANGUAGES.find((entry) => entry.code === language)?.label ?? language;

  return (
    <div className="translation-notice" role="status">
      <i className="ph-duotone ph-translate" aria-hidden="true" />
      <p>
        This page is machine-translated into {name}. Doses, dates, and numbers
        are shown exactly as printed on your document and are not translated.
        If anything reads oddly, check the original or ask your care team.
      </p>
    </div>
  );
}

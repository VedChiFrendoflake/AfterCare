import type { ReactNode } from "react";

/**
 * Content that must reach the reader exactly as printed on their document.
 *
 * Drug names, doses, frequencies, and appointment times are wrapped in this so
 * page translation leaves them alone. Machine translation is good at prose and
 * unreliable at the things that matter most here: it will happily reformat a
 * number, localise a decimal separator, or drop the "not" in "do not take with
 * food". The app's promise is that it never alters a dose, schedule, or
 * warning — that has to hold in every language, not just English.
 *
 * Prose is deliberately left translatable. Explaining the document is the whole
 * point; it's the values inside it that stay verbatim.
 */
export function Verbatim({
  children,
  as: Tag = "span",
  className,
}: {
  children: ReactNode;
  as?: "span" | "h3" | "p" | "strong" | "div";
  className?: string;
}) {
  return (
    <Tag
      translate="no"
      className={className ? `notranslate ${className}` : "notranslate"}
    >
      {children}
    </Tag>
  );
}

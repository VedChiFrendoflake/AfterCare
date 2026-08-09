import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * Tone tints the icon tile and the card's left rail.
 *
 * `alert` is reserved for the emergency card. On a dashboard where every panel
 * looked identical, the one panel a patient might need in a hurry read exactly
 * like the one listing their restrictions.
 */
export type CardTone = "neutral" | "accent" | "alert";

export function Card({
  title,
  icon,
  tone = "neutral",
  action,
  count,
  children,
}: {
  title?: string;
  icon?: string;
  tone?: CardTone;
  /** Turns the whole card into one target rather than hiding a link in the text. */
  action?: { to: string; label: string };
  /** Shown beside the title, so the dashboard answers "how many" at a glance. */
  count?: number;
  children: ReactNode;
}) {
  const body = (
    <>
      {title && (
        <div className="card-head">
          {icon && (
            <span className={`card-icon tone-${tone}`} aria-hidden="true">
              <i className={`ph-duotone ${icon}`} />
            </span>
          )}
          <h2>{title}</h2>
          {typeof count === "number" && count > 0 && (
            <span className="card-count">{count}</span>
          )}
        </div>
      )}
      <div className="card-body">{children}</div>
      {action && (
        <span className="card-action">
          {action.label}
          <i className="ph-duotone ph-arrow-right" aria-hidden="true" />
        </span>
      )}
    </>
  );

  const className = `card card-panel tone-${tone}${action ? " card-link" : ""}`;

  // A card that navigates is a link, not a div with an onClick — keyboard and
  // screen-reader users get the same affordance for free.
  return action ? (
    <Link to={action.to} className={className}>
      {body}
    </Link>
  ) : (
    <section className={className}>{body}</section>
  );
}

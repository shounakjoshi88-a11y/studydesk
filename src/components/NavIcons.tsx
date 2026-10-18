/**
 * The bottom-bar icon set.
 *
 * The generic outline set was the problem, not the icons themselves. Five
 * unrelated metaphors at the same weight — a notebook with a pen, an *open*
 * folder, a wrench, a speech bubble containing a question mark, a list with
 * two tick marks — read as a template. Every one of them was drawing two ideas
 * at once, and the extra strokes were the clutter.
 *
 * These are drawn to one rule: a single idea per icon, on a 24 grid, at one
 * stroke weight, with the same round caps and joins the empty-state mascots
 * use. Notes is a page, Files is a closed folder, Tools is a set of controls,
 * Ask is a bubble, To-dos is a finished task. Nothing repeats itself, so the
 * bar reads as five distinct places rather than five variations on "menu".
 *
 * The knobs on Tools are filled with the canvas colour so the rule appears to
 * pass behind them, which is what makes a slider read as a slider.
 */

const S = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** A page with a cut corner and one rule: a note, not a document. */
export function IconNotes() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M14.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V7.5H14.5z"
        {...S}
      />
      <path d="M9.5 12.75h5" {...S} />
    </svg>
  );
}

/** A closed folder. Closed, because these are stored, not being browsed. */
export function IconFiles() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 8.5V7A1.5 1.5 0 0 1 5.5 5.5h3.4c.5 0 .97.24 1.26.65l.5.7c.29.41.76.65 1.26.65h6.58A1.5 1.5 0 0 1 20 9v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"
        {...S}
      />
    </svg>
  );
}

/** Two rules with knobs: a set of utilities, and the only "settings" idea here. */
export function IconTools() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 8.5h5.5" {...S} />
      <path d="M14.5 8.5H20" {...S} />
      <path d="M4 15.5h3.5" {...S} />
      <path d="M12.5 15.5H20" {...S} />
      <circle cx="12" cy="8.5" r="2.3" {...S} fill="var(--background)" />
      <circle cx="10" cy="15.5" r="2.3" {...S} fill="var(--background)" />
    </svg>
  );
}

/** A bubble with nothing in it. The question mark was a second idea on top. */
export function IconAsk() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4.5 6.5h15A1.5 1.5 0 0 1 21 8v8.5a1.5 1.5 0 0 1-1.5 1.5h-8.2a1.5 1.5 0 0 0-1.06.44L6.5 21.5v-3H4.5A1.5 1.5 0 0 1 3 16.5V8a1.5 1.5 0 0 1 1.5-1.5z"
        {...S}
      />
    </svg>
  );
}

/** One stroke, one meaning: it is done. */
export function IconTodos() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.75 12.5l4.75 4.75L19.25 6.5" {...S} />
    </svg>
  );
}

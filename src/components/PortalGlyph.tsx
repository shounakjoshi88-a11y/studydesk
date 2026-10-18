/**
 * Portal sign glyph — the one memorable element on the Juno sign-in sheet.
 *
 * Artwork: a student lying on their side on a ledge, cheek resting on one
 * hand, the other hand pointing straight down. There is deliberately no
 * drawn form: the thing the finger is aimed at is the real Username field
 * a few pixels below this picture. An illustration of a sign-in box on a
 * screen that already has one would have been one box too many.
 *
 * The drawing is a line-art sticker — a near-black edge around a pale core,
 * with a single accent. It sits straight on the dark sheet with no panel of
 * its own: the drawing is pale, so it reads against the background already,
 * and the near-black outlines keep doing their real job of separating one
 * pale shape from the next. The accent is our own --brand, so the picture
 * and the app are the same world rather than artwork dropped into a product.
 *
 * Progress-linked, not decoration, so the student never wonders whether the
 * tap landed:
 *
 *   idle     the drawing assembles in reading order, then the hand keeps
 *            slowly indicating the field below
 *   working  the pointing quickens and the three accent dashes run off the
 *            fingertip
 *   ok       the dashes clear and a tick draws where they were
 *   error    the whole figure nudges twice and holds — nothing turns red,
 *            because the message under the button already said what failed
 *
 * Motion is transform, opacity and stroke-dashoffset only, so it stays on
 * the compositor. Two SVG gotchas are worth knowing if you edit this:
 * a CSS `transform` animation silently overrides a `transform` attribute on
 * the same element, so anything animated carries its rotate/translate on a
 * wrapper `<g>`; and the independent `translate`/`rotate` properties are
 * used precisely because they compose with an attribute instead of
 * replacing it. The assembled frame is the design — with reduced motion
 * every animation is dropped and that frame still reads as finished.
 */

export type PortalState = "idle" | "working" | "ok" | "error";

/* The artwork's own box is 360 × 280 with most of the top half empty, so
   the viewBox is cropped tight to the drawing. Every pixel of slack left in
   here is slack between the fingertip and the field it is pointing at. */
export function PortalGlyph({
  state,
  width = 300,
}: {
  state: PortalState;
  width?: number;
}) {
  return (
    <svg
      width={width}
      height={(width * 178) / 344}
      viewBox="16 112 344 178"
      fill="none"
      className={`pg pg-${state}`}
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      <g className="pg-figure">
        <g transform="translate(-22 0)">
          {/* the ledge */}
          <rect className="pg-in pg-l1" x="50" y="236" width="270" height="18" rx="9" fill="var(--fig-ground)" />

          {/* far leg, then its sneaker. Every limb is a wide pale stroke
              over a slightly narrower dark one, which is what produces the
              outlined edge. */}
          <path className="pg-in pg-l2" d="M268 202 312 206 342 190" stroke="var(--fig-shade)" strokeWidth="29" strokeLinecap="round" strokeLinejoin="round" />
          <path className="pg-in pg-l2" d="M268 202 312 206 342 190" stroke="var(--fig-line)" strokeWidth="25" strokeLinecap="round" strokeLinejoin="round" />
          <ellipse className="pg-in pg-l2" cx="351" cy="186" rx="14" ry="8" fill="var(--fig-lift)" stroke="var(--fig-line)" strokeWidth="2" transform="rotate(-30 351 186)" />

          {/* near leg, with a seam highlight down the trouser */}
          <path className="pg-in pg-l2" d="M268 210 308 224 342 216" stroke="var(--fig-shade)" strokeWidth="29" strokeLinecap="round" strokeLinejoin="round" />
          <path className="pg-in pg-l2" d="M268 210 308 224 342 216" stroke="var(--fig-line)" strokeWidth="25" strokeLinecap="round" strokeLinejoin="round" />
          <path className="pg-in pg-l2" d="M282 208 308 218 334 212" stroke="var(--fig-lift)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          <ellipse className="pg-in pg-l2" cx="352" cy="214" rx="14" ry="8" fill="var(--fig-lift)" stroke="var(--fig-line)" strokeWidth="2" />

          {/* the bent leg, and the shoe on the end of it */}
          <path className="pg-in pg-l3" d="M138 214 118 234 104 210" stroke="var(--fig-line)" strokeWidth="24" strokeLinecap="round" strokeLinejoin="round" />
          <path className="pg-in pg-l3" d="M138 214 118 234 104 210" stroke="var(--fig-lift)" strokeWidth="20" strokeLinecap="round" strokeLinejoin="round" />
          <g className="pg-in pg-l3" transform="translate(104 210) rotate(148)">
            <ellipse cx="13" cy="9" rx="4.5" ry="8" fill="var(--fig-lift)" stroke="var(--fig-line)" strokeWidth="2" />
            <rect x="-12" y="-2" width="24" height="17" rx="7" fill="var(--fig-lift)" stroke="var(--fig-line)" strokeWidth="2" />
            <rect x="-12" y="9" width="24" height="18" rx="8" fill="var(--fig-lift)" stroke="var(--fig-line)" strokeWidth="2" />
            <line x1="-4" y1="16" x2="-4" y2="26" stroke="var(--fig-line)" strokeWidth="1.8" strokeLinecap="round" />
            <line x1="4" y1="16" x2="4" y2="26" stroke="var(--fig-line)" strokeWidth="1.8" strokeLinecap="round" />
            <rect x="-13" y="-9" width="26" height="10" rx="4" fill="var(--fig-lift)" stroke="var(--fig-line)" strokeWidth="2" />
          </g>

          {/* the chunky turtleneck: body, one fold, ribbed cuff, ribbed hem */}
          <rect className="pg-in pg-l3" x="118" y="172" width="150" height="62" rx="30" fill="var(--fig-lift)" stroke="var(--fig-line)" strokeWidth="2.5" />
          <path className="pg-in pg-l3" d="M204 180q-8 20-2 42" stroke="var(--fig-line)" strokeWidth="2" strokeLinecap="round" />
          <rect className="pg-in pg-l3" x="250" y="176" width="20" height="54" rx="8" fill="var(--fig-lift)" stroke="var(--fig-line)" strokeWidth="2.5" />
          {[256, 260, 264].map((x) => (
            <line key={x} className="pg-in pg-l4" x1={x} y1="181" x2={x} y2="225" stroke="var(--fig-line)" strokeWidth="2" strokeLinecap="round" />
          ))}
          <rect className="pg-in pg-l3" x="104" y="182" width="32" height="24" rx="9" fill="var(--fig-lift)" stroke="var(--fig-line)" strokeWidth="2.5" />
          {[112, 118, 124, 130].map((x) => (
            <line key={x} className="pg-in pg-l4" x1={x} y1="187" x2={x} y2="202" stroke="var(--fig-line)" strokeWidth="2" strokeLinecap="round" />
          ))}

          {/* the cheek, resting on the other hand */}
          <g className="pg-in pg-l4" transform="translate(104 210) rotate(148)">
            <ellipse cx="-13" cy="9" rx="4.5" ry="8" fill="var(--fig-lift)" stroke="var(--fig-line)" strokeWidth="2" />
            <rect x="-12" y="-2" width="24" height="17" rx="7" fill="var(--fig-lift)" stroke="var(--fig-line)" strokeWidth="2" />
            <rect x="-12" y="9" width="24" height="18" rx="8" fill="var(--fig-lift)" stroke="var(--fig-line)" strokeWidth="2" />
            <line x1="-4" y1="16" x2="-4" y2="26" stroke="var(--fig-line)" strokeWidth="1.8" strokeLinecap="round" />
            <line x1="4" y1="16" x2="4" y2="26" stroke="var(--fig-line)" strokeWidth="1.8" strokeLinecap="round" />
            <rect x="-13" y="-9" width="26" height="10" rx="4" fill="var(--fig-lift)" stroke="var(--fig-line)" strokeWidth="2" />
          </g>

          {/* The pointing arm, and the hand on the end of it, in ONE group
              that pivots at the shoulder.

              Rotating the hand on its own was wrong in a way that was
              immediately visible: the palm turned while the forearm stood
              still, so the wrist came apart from the sleeve. A limb is one
              rigid thing — the gesture has to start at the shoulder or not
              start at all. The pivot is set with CSS transform-origin
              rather than a transform attribute, because an animated
              transform attribute would replace the group's own offset. */}
          <g className="pg-arm" style={{ transformOrigin: "150px 190px" }}>
            <path className="pg-in pg-l5" d="M150 190 180 224 190 240" stroke="var(--fig-line)" strokeWidth="30" strokeLinecap="round" strokeLinejoin="round" />
            <path className="pg-in pg-l5" d="M150 190 180 224 190 240" stroke="var(--fig-lift)" strokeWidth="26" strokeLinecap="round" strokeLinejoin="round" />
            <g transform="translate(191 242) rotate(-32)">
              <ellipse cx="-13" cy="10" rx="4.5" ry="8" fill="var(--fig-lift)" stroke="var(--fig-line)" strokeWidth="2" />
              <circle cx="-8" cy="23" r="5" fill="var(--fig-lift)" stroke="var(--fig-line)" strokeWidth="2" />
              <circle cx="-1" cy="24" r="5" fill="var(--fig-lift)" stroke="var(--fig-line)" strokeWidth="2" />
              <rect x="-12" y="-2" width="24" height="24" rx="9" fill="var(--fig-lift)" stroke="var(--fig-line)" strokeWidth="2" />
              <rect className="pg-in pg-l6" x="2" y="8" width="9" height="26" rx="4.5" fill="var(--fig-lift)" stroke="var(--fig-line)" strokeWidth="2" />
              <rect className="pg-in pg-l6" x="3.2" y="14" width="6.6" height="14" fill="var(--fig-lift)" />
              <line x1="-5" y1="15" x2="-5" y2="21" stroke="var(--fig-line)" strokeWidth="1.8" strokeLinecap="round" />
              <rect className="pg-in pg-l6" x="-13" y="-9" width="26" height="10" rx="4" fill="var(--fig-lift)" stroke="var(--fig-line)" strokeWidth="2" />
              {[-6, 0, 6].map((x) => (
                <line key={x} className="pg-in pg-l6" x1={x} y1="-6" x2={x} y2="-2" stroke="var(--fig-line)" strokeWidth="1.8" strokeLinecap="round" />
              ))}
            </g>
          </g>

          {/* the three accent dashes at the fingertip. Working runs them
              off the end; ok replaces them with a tick. */}
          {state === "working" ? (
            <>
              <path className="pg-dash pg-l7" d="M222 262 229 264" stroke="var(--brand)" strokeWidth="4" strokeLinecap="round" />
              <path className="pg-dash pg-l7" d="M220 270 226 274" stroke="var(--brand)" strokeWidth="4" strokeLinecap="round" />
              <path className="pg-dash pg-l7" d="M194 272 196 278" stroke="var(--brand)" strokeWidth="4" strokeLinecap="round" />
            </>
          ) : state === "ok" ? (
            <path
              className="pg-tick"
              pathLength="1"
              d="M203 268 209 275 220 261"
              stroke="var(--att-safe)"
              strokeWidth="5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ) : (
            <>
              <path className="pg-in pg-l7" d="M222 262 229 264" stroke="var(--brand)" strokeWidth="4" strokeLinecap="round" />
              <path className="pg-in pg-l7" d="M220 270 226 274" stroke="var(--brand)" strokeWidth="4" strokeLinecap="round" />
              <path className="pg-in pg-l7" d="M194 272 196 278" stroke="var(--brand)" strokeWidth="4" strokeLinecap="round" />
            </>
          )}

          {/* the head, drawn last so it sits over the sweater */}
          <g className="pg-in pg-l5" transform="translate(108 162) rotate(-8)">
            <g fill="var(--fig-shade)">
              {[[-24, -14, 15], [-8, -26, 16], [12, -26, 16], [26, -12, 15], [-28, 6, 13], [28, 6, 12], [-16, -24, 12], [0, -29, 13], [16, -24, 12]].map(
                ([cx, cy, r]) => <circle key={`${cx},${cy}`} cx={cx} cy={cy} r={r} />
              )}
            </g>
            <g fill="var(--fig-hair)">
              {[[-24, -14, 13], [-8, -26, 14], [12, -26, 14], [26, -12, 13], [-28, 6, 11], [28, 6, 10]].map(
                ([cx, cy, r]) => <circle key={`${cx},${cy}`} cx={cx} cy={cy} r={r} />
              )}
            </g>
            <circle cx="0" cy="0" r="28" fill="var(--fig-lift)" />
            <g fill="var(--fig-hair)">
              {[[-16, -24, 10], [0, -29, 11], [16, -24, 10]].map(
                ([cx, cy, r]) => <circle key={`${cx},${cy}`} cx={cx} cy={cy} r={r} />
              )}
            </g>
            <path className="pg-in pg-l6" d="M-15 2q5 5 10 0" stroke="var(--fig-line)" strokeWidth="2.2" strokeLinecap="round" />
            <path className="pg-in pg-l6" d="M5 2q5 5 10 0" stroke="var(--fig-line)" strokeWidth="2.2" strokeLinecap="round" />
            <path className="pg-in pg-l6" d="M1 6q4 3 0 7" stroke="var(--fig-line)" strokeWidth="2" strokeLinecap="round" />
            <circle className="pg-in pg-l6" cx="-17" cy="12" r="4.5" fill="var(--fig-blush)" opacity="0.55" />
            <circle className="pg-in pg-l6" cx="17" cy="12" r="4.5" fill="var(--fig-blush)" opacity="0.55" />
            <path className="pg-in pg-l6" d="M-8 17q8 6 16 0" stroke="var(--fig-line)" strokeWidth="2.2" strokeLinecap="round" />
          </g>

          <path className="pg-in pg-l7" d="M150 140q6 9 0 14-6-5 0-14Z" fill="var(--brand)" />
        </g>
      </g>
    </svg>
  );
}

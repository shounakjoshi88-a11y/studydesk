/**
 * Juno sign-in sheet.
 *
 * The credentials form used to sit inline in the Campus tab, side by side in
 * a 2-up row, which left the username about 150px wide and both fields
 * squashed against the row above it. It now lives here: a real bottom sheet
 * with one vertical edge for every field.
 *
 * Design decisions worth stating:
 *  - No heading and no subtitle. The glyph carries the meaning, the labels
 *    carry the fields, and the tab already said "Juno".
 *  - 52px inputs with 16px type, so nothing reflows and the WebView never
 *    zooms on focus.
 *  - 16px between related fields, 24px before the action — grouping by
 *    proximity rather than by adding boxes.
 *  - The save row is a tonal fill, not a bordered card, and it defaults on:
 *    saving the login is what makes the automatic attendance sign-in work.
 *  - Exactly one primary action, in paper-white, per the app's one rule.
 */

import { Check, Eye, EyeOff } from "lucide-react";
import { PortalGlyph, type PortalState } from "./PortalGlyph";
import { DragSheet } from "./DragSheet";

const labelCls = "mb-2 block text-[13px] font-medium text-ink-2";
const fieldCls =
  "w-full rounded-[12px] border border-line bg-input px-4 text-[16px] text-ink-1 " +
  "outline-none transition-colors duration-[var(--dur-2)] placeholder:text-ink-3 " +
  "focus:border-brand";

export function JunoSignInSheet({
  user,
  pass,
  remember,
  showPass,
  working,
  glyph,
  message,
  tone,
  onUser,
  onPass,
  onRemember,
  onTogglePass,
  onSubmit,
  onClose,
}: {
  user: string;
  pass: string;
  remember: boolean;
  showPass: boolean;
  working: boolean;
  glyph: PortalState;
  message: string;
  tone: "ok" | "error";
  onUser: (v: string) => void;
  onPass: (v: string) => void;
  onRemember: (v: boolean) => void;
  onTogglePass: () => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <DragSheet onClose={onClose} label="Sign in to Juno" dismissable={!working}>
      <div className="flex justify-center">
        <PortalGlyph state={glyph} width={296} />
      </div>

        <form
          className="mt-2 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <div>
            <label className={labelCls} htmlFor="juno-username">
              Username
            </label>
            <input
              id="juno-username"
              name="username"
              value={user}
              onChange={(e) => onUser(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              // name + id + autocomplete are the three the Password Manager
              // spec needs to offer save and fill for this pair — including
              // when "remember me" is off, since that stores the credential
              // in the system manager instead of on the device.
              autoComplete="username"
              data-1p-ignore={false}
              data-lpignore="false"
              placeholder="College portal login"
              className={`${fieldCls} h-[52px]`}
              style={{ caretColor: "var(--brand)" }}
            />
          </div>

          <div>
            <label className={labelCls} htmlFor="juno-password">
              Password
            </label>
            <div className="relative">
              <input
                id="juno-password"
                name="password"
                value={pass}
                onChange={(e) => onPass(e.target.value)}
                type={showPass ? "text" : "password"}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="current-password"
                placeholder="Portal password"
                className={`${fieldCls} h-[52px] pr-14`}
                style={{ caretColor: "var(--brand)" }}
              />
              <button
                type="button"
                onClick={onTogglePass}
                className="absolute right-1 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center rounded-[10px] text-ink-3"
                aria-label={showPass ? "Hide password" : "Show password"}
                aria-pressed={showPass}
              >
                {showPass ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
              </button>
            </div>
          </div>

          <label
            className="pg-check-row flex min-h-[52px] cursor-pointer items-center gap-3 rounded-[12px] bg-surface-2 px-4"
            style={{ marginTop: 4 }}
          >
            <span className="pg-check-hit">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => onRemember(e.target.checked)}
                className="pg-check-input"
              />
              <span className="pg-check" aria-hidden="true">
                {remember && <Check className="size-3.5" strokeWidth={3} />}
              </span>
            </span>
            <span className="flex-1">
              <span className="block text-[14px] text-ink-1">Save password on this phone</span>
              <span className="mt-0.5 block text-[12px] text-ink-3">Attendance then signs in on its own.</span>
            </span>
          </label>

          <button
            type="submit"
            disabled={working}
            className="sd-press mt-2 flex h-[52px] w-full items-center justify-center gap-2 rounded-[12px] text-[15px] font-semibold disabled:opacity-60"
            style={{ background: "var(--paper)", color: "var(--paper-ink)" }}
          >
            {working ? "Signing in…" : "Sign in and sync"}
          </button>

          <p
            className="text-[13px]"
            style={{ color: tone === "error" ? "var(--att-critical-text)" : "var(--ink-2)" }}
            aria-live="polite"
          >
            {message}
          </p>
        </form>
    </DragSheet>
  );
}

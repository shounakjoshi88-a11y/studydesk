/**
 * Card review scheduling, and the small time helpers the Campus tabs need.
 *
 * This is the difference between a deck being a list and a deck being
 * useful. Without it, "Study" walks every card in the deck in random order,
 * which means every session re-shows the twelve cards you already know and
 * buries the three you keep forgetting. `due` turns the deck into a queue:
 * a student opens Cards, sees "6 due", and that is exactly the work waiting.
 *
 * Deliberately a box system rather than real SM-2. Four boxes is enough to
 * stop re-showing what you know, it has one rule per card instead of a
 * dozen, and it can be explained in a sentence. Anything cleverer would be
 * harder to reason about than the thing it is scheduling.
 */

import type { Deck, PinnedTask } from "./store";

export type FlashCard = Deck["cards"][number];

/** Days until a card in each box comes back. Box 0 is due immediately. */
export const INTERVAL_DAYS = [0, 1, 3, 7];
const DAY = 86_400_000;

export function cardBox(c: FlashCard): number {
  return Math.max(0, Math.min(INTERVAL_DAYS.length - 1, c.box ?? 0));
}

/** Never-seen cards are always due; otherwise it is the box's interval. */
export function cardDue(c: FlashCard, now: number): boolean {
  if (!c.last) return true;
  return c.last + INTERVAL_DAYS[cardBox(c)]! * DAY <= now;
}

/** Move the card one step forward on "knew it", or back to relearning. */
export function gradeCard(c: FlashCard, knew: boolean, now: number): FlashCard {
  const box = knew ? cardBox(c) + 1 : 0;
  return { ...c, box: Math.min(INTERVAL_DAYS.length - 1, box), last: now };
}

export type DeckStats = { total: number; seen: number; due: number };

export function deckStats(deck: Deck, now: number): DeckStats {
  let seen = 0;
  let due = 0;
  for (const c of deck.cards) {
    if (c.last) seen++;
    if (cardDue(c, now)) due++;
  }
  return { total: deck.cards.length, seen, due };
}

/** Sort decks so the ones that actually need you come first. */
export function byDue(decks: Deck[], now: number): Deck[] {
  return [...decks].sort((a, b) => {
    const sa = deckStats(a, now);
    const sb = deckStats(b, now);
    if (sa.due !== sb.due) return sb.due - sa.due;
    if (a.cards.length !== b.cards.length) return b.cards.length - a.cards.length;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Pins are deadlines, not notes, so the useful thing to say is how long is
 * left. Deliberately two words: "in 3h", "overdue". A student glancing at
 * their lockscreen has no patience for "2 days 4 hours remaining".
 */
export function relative(ts: number, now: number): { text: string; overdue: boolean } {
  const d = ts - now;
  const over = d < 0;
  const m = Math.abs(d);
  const mins = Math.round(m / 60_000);
  const unit =
    mins < 60
      ? `${mins}m`
      : m < DAY
        ? `${Math.round(m / 3_600_000)}h`
        : m < DAY * 7
          ? `${Math.round(m / DAY)}d`
          : new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return { text: over ? `overdue ${unit}` : `in ${unit}`, overdue: over };
}

/** "Today 4pm", "Tomorrow 9am", "12 Sep". */
export function whenLabel(ts: number, now: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - midnight.getTime()) / DAY);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

/** Overdue first, then soonest, then no-date last. */
export function byDueTime(tasks: PinnedTask[]): PinnedTask[] {
  return [...tasks].sort((a, b) => {
    const ad = a.due ?? Number.POSITIVE_INFINITY;
    const bd = b.due ?? Number.POSITIVE_INFINITY;
    return ad - bd;
  });
}

/** `datetime-local` wants "YYYY-MM-DDTHH:mm" in local time. */
export function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): number | undefined {
  if (!v) return undefined;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : undefined;
}

export type TimeOfDay = { h: number; m: number; ap: "AM" | "PM" };

/**
 * Combine a picked day with a picked time of day.
 *
 * Split out of the screen because the picker is a 12-hour clock while a
 * timestamp is not: 12 AM is hour 0 and 12 PM is hour 12, and getting that
 * backwards is the kind of bug that silently marks a deadline a day early.
 */
export function dueAt(day: string, t: TimeOfDay): number | undefined {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return undefined;
  const h24 = (t.h % 12) + (t.ap === "PM" ? 12 : 0);
  const ts = new Date(y, m - 1, d, h24, t.m, 0, 0).getTime();
  return Number.isFinite(ts) ? ts : undefined;
}
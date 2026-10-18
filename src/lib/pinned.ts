import { LocalNotifications } from "@capacitor/local-notifications";
import type { PinnedTask } from "./store";

const nid = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return 900000000 + Math.abs(h % 99999999);
};

/** Sticky lockscreen notification. Stays until unpinned. */
export async function postPinned(t: PinnedTask): Promise<void> {
  await LocalNotifications.requestPermissions();
  await LocalNotifications.cancel({ notifications: [{ id: nid(t.id) }] }).catch(() => {});
  await LocalNotifications.schedule({
    notifications: [{
      id: nid(t.id),
      title: t.due ? "Due now" : "Pinned task",
      body: t.text.slice(0, 140),
      schedule: { at: new Date(Date.now() + 1500) },
      ongoing: true,
      autoCancel: false,
    }],
  });

  // A pin with a deadline is worthless if the deadline only exists inside
  // this app. A second, normal notification at the due time is the whole
  // reason to have set one.
  const alarm = nid(`due-${t.id}`);
  await LocalNotifications.cancel({ notifications: [{ id: alarm }] }).catch(() => {});
  if (t.due && !t.done && t.due > Date.now()) {
    await LocalNotifications.schedule({
      notifications: [{
        id: alarm,
        title: "Due",
        body: t.text.slice(0, 140),
        schedule: { at: new Date(t.due) },
      }],
    });
  }
}

export async function unpostPinned(id: string): Promise<void> {
  await LocalNotifications.cancel({
    notifications: [{ id: nid(id) }, { id: nid(`due-${id}`) }],
  }).catch(() => {});
}

/** Re-post every live pinned task (call on app start). */
export async function refreshPinned(tasks: PinnedTask[]): Promise<void> {
  for (const t of tasks.filter((x) => x.pinned && !x.done)) {
    try {
      await postPinned(t);
    } catch {
      /* best effort */
    }
  }
}

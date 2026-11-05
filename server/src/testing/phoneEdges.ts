// ---------------------------------------------------------------------------
// A phone's OS owns a swipe that starts on the top or bottom edge of the screen: on an iPhone the
// top edge opens Notification Center or Control Center and the bottom edge goes home or to the
// app switcher; on Android the top edge pulls down the notification shade and, with gesture
// navigation, the bottom edge goes home or to recent apps. Each of those leaves the preview's app
// with one gesture, before the in-app check that guards the NEXT action can say anything — seen on
// an iPhone 15, where a `swipe` from y=0.005 opened Control Center and the following `ui` listed
// its Airplane mode and Wi-Fi switches. So a swipe that starts there is refused on a phone.
//
// Fractions of the screen as `ui` takes them. The top band covers the status bar (54 pt of an
// iPhone 15's 852, 24-32 dp of an Android phone); the bottom band the home indicator (34 pt) and
// the gesture-navigation strip. The presets start at 0.275..0.725, so they never touch either.
// ---------------------------------------------------------------------------

export const PHONE_TOP_EDGE = 0.07;
export const PHONE_BOTTOM_EDGE = 0.95;

/** Why a swipe starting at `startY` is refused on a physical phone, or null when it may run. */
export function phoneEdgeSwipeRefusal(startY: number, os: "ios" | "android"): string | null {
  const what =
    startY < PHONE_TOP_EDGE
      ? os === "ios"
        ? "the top edge of an iPhone, which opens Notification Center or Control Center"
        : "the top edge of an Android phone, which pulls down the notification shade"
      : startY > PHONE_BOTTOM_EDGE
        ? os === "ios"
          ? "the bottom edge of an iPhone, which goes home or to the app switcher"
          : "the bottom edge of an Android phone, which goes home or to recent apps"
        : null;
  if (!what) return null;
  return (
    `this swipe starts on ${what} — outside the preview's app, so deckhand does not send it to a phone. ` +
    `Start it between y=${PHONE_TOP_EDGE} and y=${PHONE_BOTTOM_EDGE} (on the content you mean to move), use a gesture preset, or \`back\`.`
  );
}

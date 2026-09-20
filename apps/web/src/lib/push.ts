/**
 * The browser half of push notifications (issue #30, ADR-048).
 *
 * Everything in here is a conversation with the platform rather than with the
 * API: whether this browser can be notified at all, whether the person has
 * said yes, and what endpoint the push service handed out. The API only ever
 * sees the result.
 */

/** What a browser can be, from the app's point of view. */
export type PushSupport =
  /** Notifications, a service worker and a push manager are all present. */
  | 'supported'
  /**
   * Safari on iOS only offers push to an app that was added to the home
   * screen, which is the single most confusing thing about this feature: the
   * button works on a colleague's phone and does nothing on yours.
   */
  | 'needs-installation'
  | 'unsupported';

export function detectPushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  const hasApis =
    'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
  if (hasApis) return 'supported';

  // iOS before the home screen: the service worker is there, the push manager
  // is not. Anywhere else the same combination simply means no push.
  const isIos = /iP(hone|ad|od)/.test(navigator.userAgent);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true;
  if (isIos && !standalone) return 'needs-installation';

  return 'unsupported';
}

export interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** The subscription this browser already holds, if any. */
export async function readExistingSubscription(): Promise<BrowserSubscription | null> {
  if (detectPushSupport() !== 'supported') return null;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  return subscription === null ? null : toSubscription(subscription);
}

/**
 * Asks for permission and subscribes.
 *
 * Both steps in one call on purpose: a permission granted without a
 * subscription is a browser that will never be notified and a person who
 * believes it will.
 */
export async function subscribeToPush(publicKey: string): Promise<BrowserSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Dein Browser blockiert Benachrichtigungen für diese Seite. Das lässt sich nur in den Browser-Einstellungen wieder erlauben.'
        : 'Ohne Erlaubnis kann dieses Gerät nicht benachrichtigt werden.',
    );
  }

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    // Every browser worth naming refuses a subscription without a payload
    // today, and a silent push would be useless here anyway: the whole
    // message travels encrypted in the body.
    userVisibleOnly: true,
    applicationServerKey: decodeBase64Url(publicKey),
  });
  return toSubscription(subscription);
}

/** Ends this browser's subscription. Tolerates one that is already gone. */
export async function unsubscribeFromPush(): Promise<void> {
  if (detectPushSupport() !== 'supported') return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription === null) return;
  await subscription.unsubscribe();
}

/**
 * A name for this browser, proposed from what it says about itself.
 *
 * Deliberately coarse. A full user agent string is unreadable, and the point
 * is only to tell two rows apart until somebody renames them.
 */
export function proposeDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Unbekanntes Gerät';
  const agent = navigator.userAgent;

  const browser = /Firefox\//.test(agent)
    ? 'Firefox'
    : /Edg\//.test(agent)
      ? 'Edge'
      : /OPR\//.test(agent)
        ? 'Opera'
        : /Chrome\//.test(agent)
          ? 'Chrome'
          : /Safari\//.test(agent)
            ? 'Safari'
            : 'Browser';

  const platform = /Android/.test(agent)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(agent)
      ? 'iOS'
      : /Macintosh/.test(agent)
        ? 'macOS'
        : /Windows/.test(agent)
          ? 'Windows'
          : /Linux/.test(agent)
            ? 'Linux'
            : null;

  return platform === null ? browser : `${browser} auf ${platform}`;
}

function toSubscription(subscription: PushSubscription): BrowserSubscription {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (p256dh === undefined || auth === undefined) {
    // A subscription without keys cannot be encrypted to, which means it
    // cannot be used at all. Refusing it here is better than storing a row
    // that never delivers.
    throw new Error('Der Browser hat ein unvollständiges Abonnement geliefert.');
  }
  return { endpoint: subscription.endpoint, keys: { p256dh, auth } };
}

/**
 * The application server key as the push manager wants it: raw bytes, not the
 * base64url string every other part of this feature passes around.
 */
function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  // The buffer is allocated explicitly so the array is typed over an
  // `ArrayBuffer` rather than over `ArrayBufferLike`: `applicationServerKey`
  // will not take something that might be shared memory.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

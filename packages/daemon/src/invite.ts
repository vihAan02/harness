/**
 * Invite links look like `https://relay.example.com/join/<roomId>#<secret>`.
 * The secret lives in the fragment, so it never reaches a server if someone opens the link in a browser.
 */
export interface Invite {
  relayUrl: string;
  roomId: string;
  secret: string;
}

export function formatInvite(invite: Invite): string {
  return `${invite.relayUrl.replace(/\/+$/, "")}/join/${invite.roomId}#${invite.secret}`;
}

export function parseInvite(link: string): Invite {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw new Error("invite must be a URL like https://relay.example.com/join/<room>#<secret>");
  }
  const at = url.pathname.lastIndexOf("/join/");
  const roomId = at >= 0 ? url.pathname.slice(at + "/join/".length).replace(/\/+$/, "") : "";
  const secret = decodeURIComponent(url.hash.replace(/^#/, ""));
  if (!/^[0-9a-f]{24}$/.test(roomId) || secret.length < 16) {
    throw new Error("invite is missing a room id or secret");
  }
  const basePath = url.pathname.slice(0, at);
  return { relayUrl: `${url.protocol}//${url.host}${basePath}`, roomId, secret };
}

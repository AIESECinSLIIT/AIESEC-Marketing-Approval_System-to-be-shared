export const ROLES = {
  CREATOR: "OCVP Marketing",
  OCP: "OCP",
  EVENT_MANAGER: "Event / Conference Manager",
  MARKETING_MEMBER: "Marketing Member / Team Leader",
  B2C_MEMBER: "B2C Member / Team Leader",
  IGVP_MARKETING: "IGVP Marketing",
  IGVP_OGV: "IGVP OGV",
  IGP: "Initiative Group President",
  EM_VP: "LCVP Expansions Management",
  MARKETING_VP: "LCVP Marketing · ENTITY",
  B2C_VP: "LCVP B2C · ENTITY",
  ADMIN: "Super admin",
};
export const SELF_SIGNUP_ROLES = [
  "CREATOR",
  "OCP",
  "MARKETING_MEMBER",
  "B2C_MEMBER",
];
export const EVENT_ROLES = ["CREATOR", "OCP", "EVENT_MANAGER"];
export const REVIEWER_ROLES = [
  "ADMIN",
  "EM_VP",
  "IGP",
  "MARKETING_VP",
  "B2C_VP",
  "IGVP_MARKETING",
  "IGVP_OGV",
];
export const MANAGEMENT_ROLES = ["ADMIN", "EM_VP", "IGP"];
export const managementRoles = (user) =>
  Object.fromEntries(
    Object.entries(ROLES).filter(([role]) =>
      user.role === "ADMIN"
        ? role !== "ADMIN"
        : user.role === "EM_VP"
          ? [
              "IGP",
              "IGVP_MARKETING",
              "IGVP_OGV",
              "EVENT_MANAGER",
              "CREATOR",
              "OCP",
              "MARKETING_MEMBER",
              "B2C_MEMBER",
            ].includes(role)
          : ["IGVP_MARKETING", "IGVP_OGV", "EVENT_MANAGER"].includes(role),
    ),
  );
export const approvalCategoryForRole = (role) =>
  ["B2C_MEMBER", "B2C_VP", "IGVP_OGV"].includes(role) ? "B2C" : "MARKETING";
export const initialStage = (user) =>
  user.organization &&
  user.organization !== "ENTITY" &&
  ["CREATOR", "MARKETING_MEMBER", "B2C_MEMBER"].includes(user.role)
    ? "IG"
    : "LC";
export const reviewerRole = (s) =>
  s.reviewStage === "IG"
    ? s.category === "B2C"
      ? "IGVP_OGV"
      : "IGVP_MARKETING"
    : s.category === "B2C"
      ? "B2C_VP"
      : "MARKETING_VP";
export const reviewerLabel = (s) => ROLES[reviewerRole(s)];
export const canSubmit = (user) =>
  Boolean(
    user?.role &&
    !["ADMIN", "EM_VP", "IGP", "OCP", "EVENT_MANAGER"].includes(user.role),
  );
export const igReviewable = (u, s) =>
  s.organization &&
  s.organization !== "ENTITY" &&
  (u.role === "EM_VP" ||
    (u.role === "IGP" && u.organization === s.organization)) &&
  (s.reviewStage === "IG" ||
    (s.reviewStage === "LC" &&
      s.status === "PENDING" &&
      ["CREATOR", "MARKETING_MEMBER", "B2C_MEMBER"].includes(s.submitterRole)));
export const canReview = (u, s) =>
  u.id !== s.creatorId &&
  !(u.accountId && u.accountId === s.creatorAccountId) &&
  canView(u, s) &&
  (u.role === "ADMIN" ||
    igReviewable(u, s) ||
    (u.role === reviewerRole(s) && s.status === "PENDING"));
export function canView(u, s) {
  if (!u.active) return false;
  if (["OCP", "EVENT_MANAGER"].includes(u.role))
    return Boolean(
      u.eventId &&
      u.eventId === s.eventId &&
      u.organization === s.organization &&
      s.submitterRole === "CREATOR" &&
      s.status !== "DRAFT",
    );
  if (u.id === s.creatorId || u.role === "ADMIN") return true;
  if (s.status === "DRAFT") return false;
  if (u.role === "MARKETING_VP") return s.category === "MARKETING";
  if (u.role === "B2C_VP") return s.category === "B2C";
  return Boolean(
    s.organization &&
    s.organization !== "ENTITY" &&
    (u.role === "EM_VP" ||
      (u.organization === s.organization &&
        (u.role === "IGP" ||
          (u.role === "IGVP_MARKETING" && s.category === "MARKETING") ||
          (u.role === "IGVP_OGV" && s.category === "B2C")))),
  );
}
export function normalizeDriveLink(value = "") {
  if (!value.trim()) return "";
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid Google Drive file link.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "drive.google.com" ||
    url.port ||
    url.username ||
    url.password ||
    !(
      /^\/file\/d\/[\w-]+(?:\/|$)/.test(url.pathname) ||
      (url.pathname === "/open" &&
        /^[\w-]+$/.test(url.searchParams.get("id") || ""))
    )
  )
    throw new Error(
      "Use a Google Drive file link, such as https://drive.google.com/file/d/…/view.",
    );
  if (url.href.length > 2000) throw new Error("The video link is too long.");
  return url.href;
}

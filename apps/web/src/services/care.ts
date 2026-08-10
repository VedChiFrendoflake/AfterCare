/**
 * Client for /care — clinician access and the alert feed.
 *
 * Everything here goes through `authedFetch`, so the session-expiry handling
 * and the 401 path are the same as the rest of the app. The server is the
 * authority on who may read what; nothing in this file is a permission check.
 */

import { authedFetch, readTokens, type BackendUser } from "./backend";

export type CareLinkStatus = "pending" | "approved" | "denied" | "revoked";

export interface CareRequest {
  id: string;
  status: CareLinkStatus;
  reason?: string;
  requestedAt: string;
  respondedAt?: string;
  clinician?: BackendUser;
}

export interface LinkedPatient {
  linkId: string;
  patient?: BackendUser;
  since?: string;
}

export interface CareAlert {
  id: string;
  patientId: string;
  documentId?: string;
  symptoms: string[];
  action: string;
  severity: "call-doctor" | "emergency";
  note?: string;
  createdAt: string;
  read?: boolean;
  patient?: BackendUser;
}

export interface RaisedAlert {
  id: string;
  createdAt: string;
  /** Emails of clinicians who can see it. Empty means nobody was notified. */
  visibleTo: string[];
  delivered: boolean;
  message: string;
}

/** True when this session belongs to a clinician account. */
export function isClinician(): boolean {
  return readTokens()?.user.role === "clinician";
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `Request failed (${res.status})`;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as T;
}

/* --------------------------------- patient -------------------------------- */

export async function listCareRequests(): Promise<CareRequest[]> {
  const res = await authedFetch("/care/requests");
  return (await json<{ data: CareRequest[] }>(res)).data;
}

export async function approveRequest(linkId: string): Promise<void> {
  const res = await authedFetch(`/care/requests/${linkId}/approve`, { method: "POST" });
  await json(res);
}

export async function denyRequest(linkId: string): Promise<void> {
  const res = await authedFetch(`/care/requests/${linkId}/deny`, { method: "POST" });
  await json(res);
}

export async function revokeAccess(linkId: string): Promise<void> {
  const res = await authedFetch(`/care/links/${linkId}/revoke`, { method: "POST" });
  await json(res);
}

export async function raiseAlert(input: {
  documentId?: string;
  symptoms: string[];
  action: string;
  severity: "call-doctor" | "emergency";
  note?: string;
}): Promise<RaisedAlert> {
  const res = await authedFetch("/care/alerts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return json<RaisedAlert>(res);
}

/* -------------------------------- clinician ------------------------------- */

export async function requestAccess(
  patientEmail: string,
  reason?: string,
): Promise<{ message: string }> {
  const res = await authedFetch("/care/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ patientEmail, reason }),
  });
  return json<{ message: string }>(res);
}

export async function listSentRequests(): Promise<CareRequest[]> {
  const res = await authedFetch("/care/requests/sent");
  return (await json<{ data: CareRequest[] }>(res)).data;
}

export async function listPatients(): Promise<LinkedPatient[]> {
  const res = await authedFetch("/care/patients");
  return (await json<{ data: LinkedPatient[] }>(res)).data;
}

export async function patientPlan(patientId: string) {
  const res = await authedFetch(`/care/patients/${patientId}/plan`);
  return json<{ patient?: BackendUser; documentId?: string; plan: unknown }>(res);
}

/* ---------------------------------- alerts -------------------------------- */

export async function listAlerts(): Promise<CareAlert[]> {
  const res = await authedFetch("/care/alerts");
  return (await json<{ data: CareAlert[] }>(res)).data;
}

export async function markAlertRead(alertId: string): Promise<void> {
  const res = await authedFetch(`/care/alerts/${alertId}/read`, { method: "POST" });
  await json(res);
}

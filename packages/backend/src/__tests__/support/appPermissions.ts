import { OxyAppPermissionError, OxyServer } from '@oxy.so/core/server';
import { spyOn } from 'bun:test';

import { staffPermission } from '../../modules/console/consoleAuth';
import type { StaffRole } from '../../modules/console/console.collections';
import { CROWDSOURCE_OXY_APPLICATION_ID } from '../../modules/identity/oxyService';

/**
 * Stands in for Oxy's application roles (`GET /applications/:id/roles/me`).
 *
 * It replaces exactly the read `OxyServer.appPermissionsFor` makes — who holds
 * which `trust_safety.<role>` key — so the gate this service owns runs for real:
 * which role a route needs, 401 before 403, 503 for an Oxy that cannot answer.
 * The SDK's own caching (answers only, never a refusal or an outage) is the
 * SDK's to prove; this records every read so a suite can show each request
 * asked again.
 */
const granted = new Map<string, readonly string[]>();
let unavailable = false;
export const appPermissionReads: { userId: string; fresh: boolean }[] = [];

spyOn(OxyServer.prototype, 'appPermissionsFor').mockImplementation(async (request, options) => {
  // The backend's gates pass an Express request after `middleware.auth()`; an MCP
  // tool call (the source's other shape) carries no user id and reads as none.
  const userId = 'userId' in request ? request.userId : undefined;
  if (!userId) {
    throw new OxyAppPermissionError('APP_PERMISSION_SESSION_REQUIRED', 'No session');
  }
  appPermissionReads.push({ userId, fresh: options?.fresh === true });
  if (unavailable) {
    throw new OxyAppPermissionError('APP_PERMISSION_UNAVAILABLE', 'Oxy could not be asked');
  }
  const permissions = [...(granted.get(userId) ?? [])].sort();
  return {
    applicationId: CROWDSOURCE_OXY_APPLICATION_ID,
    operatorId: userId,
    permissions,
    has: (permission: string) => permissions.includes(permission),
  };
});

/** Grants exactly these Trust & Safety roles (replacing any held before). */
export function grantStaffRoles(oxyUserId: string, roles: readonly StaffRole[]): void {
  granted.set(oxyUserId, roles.map(staffPermission));
}

/** Revokes every Trust & Safety role, as an Oxy admin would. */
export function revokeStaffRoles(oxyUserId: string): void {
  granted.delete(oxyUserId);
}

/** Makes Oxy unable to answer until set back. */
export function setAppPermissionsUnavailable(value: boolean): void {
  unavailable = value;
}

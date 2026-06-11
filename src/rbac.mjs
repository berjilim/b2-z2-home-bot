// ============================================================
// RBAC store — user registry and invite engine
// ============================================================
// Reads/writes two flat JSON files under /data/rbac/:
//   users.json   — who has access and at what role
//   invites.json — pending/used invite tokens
//
// Roles:
//   owner  — full access + user management
//   member — chat + arm orders + receive notifications
//   guest  — chat and status queries only
//
// Notification routing: wake notifications and notify-type
// standing-order alerts go to the user who armed the order
// (order.created_by). Falls back to owner if missing/expired.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const ROLE_CAPABILITIES = {
    owner:  ["chat", "arm_orders", "manage_users", "receive_notify"],
    member: ["chat", "arm_orders", "receive_notify"],
    guest:  ["chat"],
};

export class RbacStore {
    #usersPath;
    #invitesPath;

    constructor({ usersPath, invitesPath }) {
        this.#usersPath = usersPath;
        this.#invitesPath = invitesPath;
    }

    // --- reads ---

    #readUsers() {
        try { return JSON.parse(readFileSync(this.#usersPath, "utf-8")); }
        catch { return []; }
    }

    #readInvites() {
        try { return JSON.parse(readFileSync(this.#invitesPath, "utf-8")); }
        catch { return []; }
    }

    // --- writes ---

    #writeUsers(users) {
        mkdirSync(dirname(this.#usersPath), { recursive: true });
        writeFileSync(this.#usersPath, JSON.stringify(users, null, 2));
    }

    #writeInvites(invites) {
        mkdirSync(dirname(this.#invitesPath), { recursive: true });
        writeFileSync(this.#invitesPath, JSON.stringify(invites, null, 2));
    }

    // --- public API ---

    /** Get a user by Telegram user ID. Returns null if not found or expired. */
    getUser(userId) {
        const u = this.#readUsers().find((u) => u.userId === String(userId)) ?? null;
        if (!u) return null;
        if (u.expiresAt && new Date(u.expiresAt) < new Date()) return null;
        return u;
    }

    hasCapability(userId, capability) {
        const user = this.getUser(userId);
        if (!user) return false;
        return (ROLE_CAPABILITIES[user.role] ?? []).includes(capability);
    }

    listUsers() {
        return this.#readUsers();
    }

    listInvites() {
        return this.#readInvites();
    }

    /**
     * Ensure the owner is in the registry. Safe to call on every startup —
     * no-ops if owner is already present.
     */
    seedOwner(ownerChatId) {
        const users = this.#readUsers();
        if (users.some((u) => u.userId === String(ownerChatId))) return;
        users.unshift({
            userId: String(ownerChatId),
            role: "owner",
            displayName: "Owner",
            addedAt: new Date().toISOString(),
            expiresAt: null,
        });
        this.#writeUsers(users);
    }

    /**
     * Redeem an invite token. Adds the user to the registry and marks the
     * invite used in one atomic write pair.
     * Returns { ok: true, role } or { ok: false, error: string }.
     */
    redeemInvite(token, userId, displayName) {
        const invites = this.#readInvites();
        const idx = invites.findIndex((i) => i.token === token && !i.usedBy);
        if (idx === -1) return { ok: false, error: "invalid or already used" };

        const invite = invites[idx];
        if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
            return { ok: false, error: "invite expired" };
        }

        invites[idx] = { ...invite, usedBy: String(userId), usedAt: new Date().toISOString() };
        this.#writeInvites(invites);

        const users = this.#readUsers();
        if (!users.some((u) => u.userId === String(userId))) {
            users.push({
                userId: String(userId),
                role: invite.role,
                displayName: displayName || null,
                addedAt: new Date().toISOString(),
                expiresAt: invite.userExpiresAt ?? null,
            });
            this.#writeUsers(users);
        }

        return { ok: true, role: invite.role };
    }

    /**
     * Get the Telegram chat ID notifications for `order` should go to.
     * Uses order.created_by if that user still has receive_notify capability;
     * otherwise falls back to the owner.
     */
    getChatIdForOrder(order, ownerChatId) {
        const createdBy = order?.created_by;
        if (createdBy && this.hasCapability(createdBy, "receive_notify")) {
            return String(createdBy);
        }
        return String(ownerChatId);
    }
}

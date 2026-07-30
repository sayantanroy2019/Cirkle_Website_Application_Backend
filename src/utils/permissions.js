// Capability map for admin roles. Endpoints check capabilities via can(),
// never role names directly — so future role/permission changes happen in
// this one map, not scattered across every endpoint.
const PERMISSIONS = {
    administrative:        ['manage_admins', 'manage_organizers', 'manage_events', 'view_all', 'refunds', 'manage_reference'],
    business_development:  ['manage_organizers', 'manage_events', 'view_all', 'refunds', 'manage_reference']
};

/**
 * Returns true if the admin is allowed to perform the given capability.
 * @param {{ role: string }} admin
 * @param {string} capability
 */
export function can(admin, capability) {
    return PERMISSIONS[admin.role]?.includes(capability) ?? false;
}

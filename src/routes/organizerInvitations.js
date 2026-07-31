import express from 'express';
import { pool } from '../config/db.js';
import authenticateOrganizer from '../middlewares/authenticateOrganizer.js';

const organizerInvitationsRouter = express.Router();

const DECISION_TO_STATUS = { accept: 'accepted', reject: 'rejected' };

organizerInvitationsRouter.use(authenticateOrganizer);

// POST /organizer/invitations/:invitationId/decision
// The one write action in the organizer dashboard. Ownership is checked via
// event_invitations.organizer_id — exactly what that column (Part 1) is
// for. Terminal states (accepted/rejected) are permanent: no un-deciding.
//
// The consumer-side gate (POST /payments/orders checking for an accepted
// invitation) already exists and needs no change — accepting here flows
// straight into the existing purchase gate.
organizerInvitationsRouter.post('/:invitationId/decision', async (req, res) => {
    const { invitationId } = req.params;
    const { decision } = req.body;
    const organizerId = req.organizer.organizerId;

    if (!DECISION_TO_STATUS[decision]) {
        return res.status(400).json({ error: "decision must be 'accept' or 'reject'" });
    }
    const newStatus = DECISION_TO_STATUS[decision];

    const client = await pool.connect();

    try {
        const invResult = await client.query(
            'SELECT id, status, organizer_id FROM event_invitations WHERE id = $1',
            [invitationId]
        );

        // Not found, or belongs to a different organizer — 404 either way,
        // never 403. Don't confirm the invitation exists to someone who
        // shouldn't see it.
        if (invResult.rows.length === 0 || invResult.rows[0].organizer_id !== organizerId) {
            return res.status(404).json({ error: 'Invitation not found' });
        }

        const invitation = invResult.rows[0];

        if (invitation.status !== 'pending') {
            return res.status(409).json({ error: `This invitation has already been ${invitation.status}` });
        }

        await client.query('BEGIN');

        const updated = await client.query(
            `UPDATE event_invitations
             SET status = $1, updated_at = now()
             WHERE id = $2
             RETURNING status`,
            [newStatus, invitationId]
        );

        await client.query('COMMIT');

        res.json({ invitationId, status: updated.rows[0].status });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('POST /organizer/invitations/:invitationId/decision error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    } finally {
        client.release();
    }
});

export default organizerInvitationsRouter;

import {
  getNoteRemindersForUser,
  isValidReminderId,
  markAllNoteRemindersRead,
  markNoteReminderRead
} from '../lib/noteReminders.js'

export default async function noteReminderRoutes(fastify) {
  fastify.get('/note-reminders', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')

    return getNoteRemindersForUser(request.currentUser.id, {
      limit: request.query?.limit
    })
  })

  fastify.post('/note-reminders/:reminderId/read', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    if (!isValidReminderId(request.params.reminderId)) {
      reply.code(400)
      return { error: 'Invalid reminder id' }
    }

    const reminder = await markNoteReminderRead(
      request.currentUser.id,
      request.params.reminderId
    )

    if (!reminder) {
      reply.code(404)
      return { error: 'Reminder not found' }
    }

    return {
      ok: true,
      readAt: reminder.read_at
    }
  })

  fastify.post('/note-reminders/read-all', async (request, reply) => {
    await fastify.requireAuth(request, reply)

    const updatedCount = await markAllNoteRemindersRead(request.currentUser.id)
    return { ok: true, updatedCount }
  })
}

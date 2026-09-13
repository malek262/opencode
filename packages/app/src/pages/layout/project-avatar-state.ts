import { createMemo, type Accessor } from "solid-js"
import { useGlobal } from "@/context/global"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { sessionPermissionRequest, sessionQuestionRequest } from "@/pages/session/composer/session-request-tree"
import { ServerConnection } from "@/context/server"

export function useSessionTabAvatarState(
  server: Accessor<ServerConnection.Key>,
  directory: Accessor<string>,
  sessionId: Accessor<string>,
) {
  const global = useGlobal()
  const notification = useNotification()
  const permission = usePermission()
  const connection = createMemo(() => global.servers.list().find((item) => ServerConnection.key(item) === server()))
  const sync = createMemo(() => {
    const conn = connection()
    if (conn) return global.ensureServerCtx(conn).sync
  })
  const hasPermissions = createMemo(() => {
    const serverSync = sync()
    if (!serverSync) return false
    const permissionState = permission.ensureServerState(server())
    // Subscribe to the permission data before the store probe: peek() is non-reactive, and
    // returning early here would leave the memo permanently unsubscribed when the child
    // store does not exist yet (sidebar rows evaluate before the session page boots).
    const permissions = serverSync.session.data.permission
    const store = serverSync.peek(directory())
    if (!store) return !!permissions[sessionId()]?.some((item) => !permissionState.autoResponds(item, directory()))
    return !!sessionPermissionRequest(store[0].session, permissions, sessionId(), (item) => {
      return !permissionState.autoResponds(item, directory())
    })
  })
  const hasQuestions = createMemo(() => {
    const serverSync = sync()
    if (!serverSync) return false
    const questions = serverSync.session.data.question
    const store = serverSync.peek(directory())
    if (!store) return !!questions[sessionId()]?.length
    return !!sessionQuestionRequest(store[0].session, questions, sessionId())
  })
  const needsAttention = createMemo(() => hasPermissions() || hasQuestions())
  const notificationState = createMemo(() => {
    if (!connection()) return
    return notification.ensureServerState(server())
  })
  const unread = createMemo(() => needsAttention() || (notificationState()?.session.unseenCount(sessionId()) ?? 0) > 0)
  const loading = createMemo(() => {
    const serverSync = sync()
    if (!serverSync) return false
    if (needsAttention()) return false
    return serverSync.session.data.session_working(sessionId())
  })
  return { unread, loading, attention: needsAttention }
}

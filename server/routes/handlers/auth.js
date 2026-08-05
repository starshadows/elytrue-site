import {
    authenticateUser,
    createSession,
    destroySession,
    registerUser,
    revokeAllSessions,
} from '../../auth.js'
import { apiResponse, httpError, parseCookies, readJSON } from '../../http.js'
import { enforceRateLimit } from '../../rate-limit.js'
import {
    clientIdentity,
    environmentFor,
} from '../../middleware/request-context.js'
import { authenticatedProfile, timedApiResponse } from '../handler-response.js'

export async function register(context, stores) {
    await enforceRateLimit('register', clientIdentity(context))
    const body = await readJSON(context.request, 32 * 1024)
    const { user, recoveryKey } = await registerUser(stores.data, environmentFor(context), {
        name: body.name,
        email: body.email,
        password: body.password,
    })
    const { session, cookies } = await createSession(
        stores.data,
        user,
        context.request,
        environmentFor(context),
    )
    return apiResponse({
        ...authenticatedProfile(user, environmentFor(context), session),
        recoveryKey,
    }, {
        status: 201,
        message: '注册成功',
        cookies,
    })
}

export async function login(context, stores) {
    const body = await readJSON(context.request, 32 * 1024)
    const identifier = body.identifier || body.email || body.name || ''
    await enforceRateLimit('login', clientIdentity(context, String(identifier).toLowerCase()))
    const user = await authenticateUser(
        stores.data,
        environmentFor(context),
        identifier,
        body.password || '',
    )
    const { session, cookies } = await createSession(
        stores.data,
        user,
        context.request,
        environmentFor(context),
    )
    return apiResponse(authenticatedProfile(user, environmentFor(context), session), {
        message: '登录成功',
        cookies,
    })
}

async function endSession(context, stores, auth, allDevices) {
    await enforceRateLimit(
        allDevices ? 'logoutAll' : 'logout',
        clientIdentity(context, auth.user.id),
    )
    if (allDevices) await revokeAllSessions(stores.data, auth.user)
    const cookies = await destroySession(
        stores.data,
        context.request,
        auth,
        environmentFor(context),
    )
    return apiResponse(null, { message: '已退出登录', cookies })
}

export function logout(context, stores, path, auth) {
    return endSession(context, stores, auth, false)
}

export function logoutAll(context, stores, path, auth) {
    return endSession(context, stores, auth, true)
}

export async function me(context, stores, path, auth) {
    if (!auth) {
        if (parseCookies(context.request).elytrue_session) throw httpError(401, '请先登录')
        return timedApiResponse(context, null)
    }
    return timedApiResponse(
        context,
        authenticatedProfile(auth.user, environmentFor(context), auth.session),
        { cookies: auth.refreshCookies },
    )
}

import { privateProfile } from '../auth.js'
import { apiResponse } from '../http.js'

export function authenticatedProfile(user, env, session) {
    return {
        ...privateProfile(user, env),
        csrfToken: session.csrfToken,
    }
}

export function timedApiResponse(context, data, options) {
    const operation = () => apiResponse(data, options)
    return context.requestTiming?.measureSync('serialization', operation) ?? operation()
}

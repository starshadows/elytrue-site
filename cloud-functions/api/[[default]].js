import { handleApiRequest } from '../../server/app.js'

export default function onRequest(context) {
    return handleApiRequest(context)
}

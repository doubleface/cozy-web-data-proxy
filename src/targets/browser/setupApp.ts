import memoize from 'lodash/memoize'
import { createRoot } from 'react-dom/client'

import CozyClient from 'cozy-client'
import flag from 'cozy-flags'
import { RealtimePlugin } from 'cozy-realtime'

import schema from '@/doctypes'

interface Manifest {
  name: string
  version: string
}

const manifest = require('manifest.webapp') as Manifest

interface DomData {
  token: string
  domain: string
}

/**
 * Make and returns cozy client instance
 */
const makeClient = (container: HTMLElement): CozyClient => {
  if (!container.dataset.cozy) {
    throw new Error('No data-cozy dataset found')
  }

  const data = JSON.parse(container.dataset.cozy) as DomData
  const protocol = window.location.protocol
  const cozyUrl = `${protocol}//${data.domain}`

  const client = new CozyClient({
    uri: cozyUrl,
    token: data.token,
    appMetadata: {
      slug: manifest.name,
      version: manifest.version
    },
    schema,
    disableStoreForQueries: true
  })

  return client
}

/**
 * Setup cozy-client and retrieve app container
 *
 * This method is memoized in order to optimize hot-reloading
 */
export const setupApp = memoize(() => {
  const container = document.querySelector<HTMLElement>('[role=application]')

  if (!container) {
    throw new Error('Failed to find [role=application] container')
  }

  const root = createRoot(container)
  const client = makeClient(container)
  client.registerPlugin(flag.plugin, null)
  client.registerPlugin(RealtimePlugin)

  return { root, client }
})

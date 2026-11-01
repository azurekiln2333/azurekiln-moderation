# Azurekiln moderation client

Dependency-free Node SDK. Supports Node 18+ with native fetch, CommonJS, and
ESM. Production service runtime is Node 24.15+.

```js
import { ModerationClient, ModerationUnavailableError } from '@azurekiln/moderation-client';
// CommonJS: const { ModerationClient } = require('@azurekiln/moderation-client');

const moderation = new ModerationClient({
  baseUrl: process.env.MODERATION_BASE_URL,
  appId: 'qflistudio',
  apiKey: process.env.MODERATION_API_KEY,
  timeoutMs: 3000,
  failClosed: true
});

const ip = await moderation.checkIp({ scene: 'post', ip: '192.0.2.1', userId: '42' });
const text = await moderation.checkText({ scene: 'post', text: 'Hello', userId: '42' });
if (ip.decision === 'pass' && text.decision === 'pass') {
  // Publish the content.
}
```

`checkImage({scene,imageUrl,userId?,targetType?,targetId?,metadata?})` checks an
HTTPS image reference. `submitReport({targetType,targetId,reporterId,reason})`
creates a report. `getReview(id)` polls a queued decision. Only publish when
the final decision is `pass`; keep `review` private and reject `block`.

The deadline covers both the HTTP request and response parsing. Network
failures, timeouts, invalid check responses, and HTTP 5xx check failures throw
`ModerationUnavailableError` by default. Its `code` is
`moderation.unavailable`, `status` is 503, and `message` is `审核服务暂不可用`.
For 5xx failures, `upstreamStatus`, `upstreamCode`, and `cause` preserve the
upstream error. HTTP 4xx failures throw `ModerationHttpError` with the original
`status`, `code`, and optional `requestId`.

With `failClosed:false`, unavailable checks return
`{decision:'review',unavailable:true,...}`. This result has no `reviewId` because
the service did not accept a queue item. Retain the content locally and retry.
The SDK never synthesizes `pass`. Report and review-query methods always throw
on failure, regardless of `failClosed`. A successful HTTP body is not a
guarantee that a check passed; inspect its `decision`.

Use HTTPS or an explicitly trusted private network. Redirects are rejected.
TLS certificate verification remains enabled. Supply an app API key from
server configuration. Never embed keys in a public client application.

## Self-contained consumer builds

From the service repository, run:

```sh
npm pack --workspace packages/client --pack-destination /tmp/moderation-sdk
```

Create the destination first. Copy the generated
`azurekiln-moderation-client-0.1.0.tgz` into the consumer's `vendor/` directory.
Inside that consumer run:

```sh
npm install --save ./vendor/azurekiln-moderation-client-0.1.0.tgz
```

Commit the tarball, package manifest, and lockfile in the consumer repository.
Ensure its Docker context includes `vendor/`. Copy `vendor/` into the build
stage before `npm ci`. Neither a sibling service checkout nor a private npm
registry is needed during the build. Repack and update the consumer lockfile
when the SDK changes.

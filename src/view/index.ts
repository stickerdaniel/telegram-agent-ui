// `./view`: views from the publisher's side. `prepareView` reads a view's files under the roots
// and checks it, for Node and Bun; `viewClient` publishes it to a view host over the Fetch API
// and stores the contexts of questions on it, for `createChat`'s `views`.
export { LATE_VIEW, newViewId, VIEW_TTL, viewClient, type ViewClientConfig } from './client.ts';
export { type ContentInput, type Prepared, prepareView, type TabInput, type ViewInput } from './prepare.ts';

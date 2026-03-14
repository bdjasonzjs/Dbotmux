/**
 * Pre-built Lark card action webhook event payloads for integration tests.
 */

export function makeToggleEvent(rootId: string, cardNonce?: string, operatorOpenId = 'ou_user') {
  return {
    action: { value: { action: 'toggle_stream', root_id: rootId, ...(cardNonce ? { card_nonce: cardNonce } : {}) } },
    operator: { open_id: operatorOpenId },
  };
}

export function makeRestartEvent(rootId: string, operatorOpenId = 'ou_user') {
  return {
    action: { value: { action: 'restart', root_id: rootId } },
    operator: { open_id: operatorOpenId },
  };
}

export function makeCloseEvent(rootId: string, operatorOpenId = 'ou_user') {
  return {
    action: { value: { action: 'close', root_id: rootId } },
    operator: { open_id: operatorOpenId },
  };
}

export function makeGetWriteLinkEvent(rootId: string, operatorOpenId = 'ou_user') {
  return {
    action: { value: { action: 'get_write_link', root_id: rootId } },
    operator: { open_id: operatorOpenId },
  };
}

export function makeSkipRepoEvent(rootId: string, operatorOpenId = 'ou_user') {
  return {
    action: { value: { action: 'skip_repo', root_id: rootId } },
    operator: { open_id: operatorOpenId },
  };
}

export function makeRepoSelectEvent(rootId: string, selectedPath: string, operatorOpenId = 'ou_user') {
  return {
    action: {
      option: selectedPath,
      value: { root_id: rootId },
    },
    operator: { open_id: operatorOpenId },
  };
}

/* Live room board permissions for TermKryt.
 * Include this after the main inline script in index.html.
 * Players can view the shared board but only a room-assigned spymaster can publish it.
 * Host role assignment remains in the existing player panel.
 */
(function () {
  'use strict';

  const SUPABASE_URL = 'https://jvwrfdzlydkthksitayo.supabase.co';
  const SUPABASE_ANON = 'sb_publishable_E607zJubcmiDofo4XwKBjQ_6HhIBuQG';
  const ROLE_POLL_MS = 1500;
  let client;
  let lastRoom = '';
  let lastPlayer = '';
  let currentRole = null;
  let lookupInProgress = false;

  function roomCode() {
    const label = document.getElementById('live-room-label');
    const match = label && label.textContent.match(/Room:\s*([A-Z0-9]+)/i);
    return match ? match[1].toUpperCase() : '';
  }

  function playerId(code) {
    try { return sessionStorage.getItem('termkryt_live_' + code) || ''; }
    catch (_) { return ''; }
  }

  function updateBoardAccess() {
    const board = document.getElementById('board');
    if (!board) return;
    const isInRoom = !!roomCode();
    const canEdit = !isInRoom || currentRole === 'spymaster';
    board.classList.toggle('live-board-readonly', !canEdit);
    board.setAttribute('aria-readonly', String(!canEdit));
  }

  async function refreshRole() {
    if (lookupInProgress || !client) return;
    const code = roomCode();
    const id = code && playerId(code);
    if (!code || !id) {
      currentRole = null;
      lastRoom = '';
      lastPlayer = '';
      updateBoardAccess();
      return;
    }

    if (code !== lastRoom || id !== lastPlayer) {
      lastRoom = code;
      lastPlayer = id;
      currentRole = null;
      updateBoardAccess();
    }

    lookupInProgress = true;
    try {
      const { data, error } = await client
        .from('rooms')
        .select('players')
        .eq('id', code)
        .maybeSingle();
      if (!error && data) {
        // Ignore a response for an old room if the user switched rooms while it loaded.
        if (code === roomCode() && id === playerId(code)) {
          currentRole = data.players?.[id]?.role || null;
          updateBoardAccess();
        }
      }
    } catch (error) {
      console.warn('Could not check live board role:', error);
    } finally {
      lookupInProgress = false;
    }
  }

  function installBoardPublisherGuard() {
    const original = window.pushLiveBoard;
    if (typeof original !== 'function' || original.__roleGuardInstalled) return;

    const guarded = async function () {
      const code = roomCode();
      // Outside a live room, preserve the normal local-app behavior.
      if (!code) return original.apply(this, arguments);

      const id = playerId(code);
      if (!id || !client) return;
      try {
        // Check the persisted role at publish time, rather than trusting the UI mode.
        const { data, error } = await client
          .from('rooms')
          .select('players')
          .eq('id', code)
          .maybeSingle();
        if (error || !data || data.players?.[id]?.role !== 'spymaster') {
          currentRole = data?.players?.[id]?.role || null;
          updateBoardAccess();
          return;
        }
        currentRole = 'spymaster';
        updateBoardAccess();
        return original.apply(this, arguments);
      } catch (error) {
        console.warn('Board update was not published because the role could not be checked:', error);
      }
    };
    guarded.__roleGuardInstalled = true;
    window.pushLiveBoard = guarded;
  }

  function installStyle() {
    if (document.getElementById('live-board-permission-style')) return;
    const style = document.createElement('style');
    style.id = 'live-board-permission-style';
    style.textContent = '#board.live-board-readonly { pointer-events:none; opacity:.92; }';
    document.head.appendChild(style);
  }

  function start() {
    if (!window.supabase?.createClient) return;
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
    installStyle();
    installBoardPublisherGuard();
    refreshRole();
    window.setInterval(() => {
      installBoardPublisherGuard();
      refreshRole();
    }, ROLE_POLL_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();

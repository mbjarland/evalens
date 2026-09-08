/** Keyboard state belongs to the rendered recording, not the kernel. Keys
 * identify controls by capture and purpose, never their current text or page.
 * The host retains one bounded focus description across webview rebuilds. */
export const KEYBOARD_SCRIPT = `
  if (document.body) {
    var focusScope = document.body.dataset.sourceUri;
    var focusState = vscode.getState() || {};
    if (focusState.source !== focusScope) focusState = { source: focusScope };
    var focusables = Array.prototype.slice.call(document.querySelectorAll(
      'input, button, summary, a[href], tr.row'));
    function controlKey(element) {
      var row = element.closest('tr.row');
      var result = row && row.querySelector('.whole-result');
      var token = result ? result.dataset.resultToken : row ? row.dataset.goto : '';
      var data = element.dataset;
      var details = element.closest('details');
      if (element.id) return 'id/' + element.id;
      if (data.learningToggle !== undefined) return 'learning/help';
      if (data.learningSession !== undefined) return 'learning/session-details';
      if (data.learningAction) return 'learning/' + data.learningAction;
      if (element.tagName === 'SUMMARY' && details && details.dataset.learningTopic) return 'topic/' + details.dataset.learningTopic;
      if (data.loopAction) return ['loop', data.loopToken, data.loopId,
        data.loopAction, data.loopControl || ''].join('/');
      if (data.foldAction) return ['flat', token, data.foldId,
        data.foldAction, element.classList.contains('fold-label') ? 'label' : 'footer'].join('/');
      if (element.classList.contains('result-disclosure')) return 'result/' + token;
      if (details && details.hasAttribute('data-local-disclosure')) {
        var owner = details.closest('[data-loop-entry], [data-loop-context]');
        return ['details', token, owner && (owner.dataset.loopEntry || owner.dataset.loopContext),
          details.className].join('/');
      }
      if (data.staleCause) return 'cause/' + token + '/' + data.staleCause;
      if (element.tagName === 'A') return 'link/' + element.getAttribute('href');
      return row ? 'row/' + token : undefined;
    }
    focusables = focusables.filter(function (element) {
      var key = controlKey(element);
      if (typeof key !== 'string') return false;
      element.dataset.focusKey = key;
      return true;
    });
    var localDetails = Array.prototype.slice.call(document.querySelectorAll('[data-local-disclosure]'));
    localDetails.forEach(function (details) {
      var key = controlKey(details.querySelector('summary'));
      if (focusState.details && focusState.details.includes(key)) details.open = true;
    });
    function saveFocusState() {
      focusState.source = focusScope;
      focusState.scrollY = window.scrollY;
      focusState.details = localDetails.filter(function (details) { return details.open; })
        .map(function (details) { return controlKey(details.querySelector('summary')); });
      vscode.setState(focusState);
    }
    function visibleControl(element) {
      return element && !element.disabled && !element.closest('[hidden]')
        && element.getClientRects().length > 0
        && getComputedStyle(element).visibility !== 'hidden';
    }
    function rememberedControl() {
      var target = focusables.find(function (element) {
        return element.dataset.focusKey === focusState.key && visibleControl(element);
      });
      // The next-page button can become disabled, or a nested control can
      // disappear when its parent folds. Stay within that recording first.
      var row = rows.find(function (item) {
        var result = item.querySelector('.whole-result');
        return focusState.token && result && result.dataset.resultToken === focusState.token;
      }) || rows.find(function (item) { return item.dataset.goto === focusState.line; });
      if (!target && typeof focusState.key === 'string' && focusState.key.startsWith('loop/')) {
        var prefix = focusState.key.split('/').slice(0, 4).join('/') + '/';
        target = focusables.find(function (element) {
          return typeof element.dataset.focusKey === 'string'
            && element.dataset.focusKey.startsWith(prefix) && visibleControl(element);
        });
      }
      if (!target && row) {
        var fold = row.querySelector('.result-disclosure');
        target = visibleControl(fold) ? fold : row;
      }
      return target || rows.find(function (item) { return item.tabIndex === 0; })
        || document.getElementById('follow-cursor');
    }
    function revealControl(element) {
      if (!visibleControl(element) || navigationControl.contains(element)) return;
      if (element.matches('tr.row')) { revealEdge(element); return; }
      measureLoopContexts();
      var top = navigationControl.getBoundingClientRect().bottom + 4;
      loopContexts.forEach(function (context) {
        if (context.classList.contains('loop-context-covered')
          || context.classList.contains('loop-context-unpinned')
          || context.contains(element)) return;
        var rect = context.getBoundingClientRect();
        if (rect.top <= navigationControl.getBoundingClientRect().bottom + 1) {
          top = Math.max(top, rect.bottom + 4);
        }
      });
      var rect = element.getBoundingClientRect();
      if (rect.top < top) window.scrollBy({ top: rect.top - top, behavior: 'instant' });
      else if (rect.bottom > window.innerHeight - 4) {
        window.scrollBy({ top: rect.bottom - window.innerHeight + 4, behavior: 'instant' });
      }
    }
    function rememberControl(element) {
      if (!element || typeof element.dataset.focusKey !== 'string') {
        delete focusState.key;
        delete focusState.line;
        delete focusState.token;
        saveFocusState();
        return;
      }
      var row = element.closest('tr.row');
      var result = row && row.querySelector('.whole-result');
      focusState.key = element.dataset.focusKey;
      focusState.line = row && row.dataset.goto;
      focusState.token = result && result.dataset.resultToken;
      focusState.active = true;
      saveFocusState();
    }
    document.addEventListener('focusin', function (event) {
      rememberControl(event.target);
      // Native Tab scrolling does not know about the local sticky header.
      requestAnimationFrame(function () { revealControl(event.target); });
    });
    localDetails.forEach(function (details) { details.addEventListener('toggle', saveFocusState); });
    window.addEventListener('scroll', saveFocusState, { passive: true });
    window.addEventListener('blur', function () {
      setTimeout(function () {
        if (!document.hasFocus()) { focusState.active = false; saveFocusState(); }
      }, 0);
    });
    window.addEventListener('focus', function () {
      requestAnimationFrame(function () {
        if (document.activeElement === document.body) {
          var target = rememberedControl();
          target.focus({ preventScroll: true });
          revealControl(target);
        }
      });
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || event.altKey || event.ctrlKey || event.metaKey) return;
      var element = event.target;
      var details = element.closest('details[open]');
      var help = element.closest('#learning-help');
      var row = element.closest('tr.row');
      if (details) {
        details.open = false;
        details.querySelector('summary').focus({ preventScroll: true });
        queueLoopContexts();
      } else if (help || element.hasAttribute('data-learning-toggle')
        && !document.getElementById('learning-help').hidden) {
        document.getElementById('learning-help').hidden = true;
        var helpButton = document.querySelector('[data-learning-toggle]');
        helpButton.setAttribute('aria-expanded', 'false');
        helpButton.focus({ preventScroll: true });
        vscode.postMessage({ learningTopic: 'help', learningOpen: false, revision: revision });
      } else if (row && element !== row) {
        row.focus({ preventScroll: true });
      } else return;
      // Scope Escape to this interaction; never let closing help clear results.
      event.preventDefault();
      event.stopImmediatePropagation();
      saveFocusState();
    }, true);
    if (focusState.active && focusState.key) {
      var restored = rememberedControl();
      var restoreScroll = focusState.scrollY || 0;
      restored.focus({ preventScroll: true });
      if (revealLine === null) window.scrollTo({ top: restoreScroll, behavior: 'instant' });
      requestAnimationFrame(function () { revealControl(restored); });
    }
  }
`;

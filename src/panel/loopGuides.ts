/** Decorative guides use the bounded, already-rendered loop tree. They do
 * not participate in navigation, capture or evaluation. Text rectangles are
 * measured after layout so wrapped headings and different fonts stay aligned.
 */
export const LOOP_GUIDE_SCRIPT = `
  var loopTrees = Array.prototype.slice.call(document.querySelectorAll('.loop-tree'));
  var loopGuidesQueued = false;
  function drawLoopGuides() {
    loopTrees.forEach(function (explorer) {
      var svg = explorer.querySelector('.loop-guides');
      if (!explorer.getClientRects().length) { svg.replaceChildren(); return; }
      var origin = svg.getBoundingClientRect();
      var unit = parseFloat(getComputedStyle(explorer).fontSize);
      var paths = [];
      function box(node, text) {
        if (!node || !node.getClientRects().length) return;
        var rect = node.getBoundingClientRect();
        if (text) {
          var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT), current;
          while ((current = walker.nextNode())) {
            if (!current.textContent.trim() || current.parentElement.closest('.loop-disclosure')) continue;
            var range = document.createRange(); range.selectNodeContents(current);
            var first = Array.prototype.slice.call(range.getClientRects()).find(function (r) { return r.width > 0; });
            if (first) { rect = first; break; }
          }
        }
        return { left: rect.left - origin.left, right: rect.right - origin.left,
          top: rect.top - origin.top, bottom: rect.bottom - origin.top,
          cy: rect.top + rect.height / 2 - origin.top, width: rect.width };
      }
      function add(d, kind, owner, target) {
        var path = document.createElementNS(svg.namespaceURI, 'path');
        path.setAttribute('d', d);
        path.dataset.loopGuide = kind;
        path.dataset.guideOwner = owner;
        path.dataset.guideTarget = target;
        paths.push(path);
      }
      explorer.querySelectorAll('.loop-invocation').forEach(function (invocation) {
        var groups = Array.prototype.slice.call(invocation.querySelectorAll(':scope > .loop-entries > .loop-group'));
        if (!groups.length) return;
        var source = invocation.querySelector(':scope > .loop-source');
        var firstRoot = !source && invocation.dataset.loopDepth === '0';
        if (firstRoot) source = explorer.querySelector('.loop-root-source');
        var heading = box(source, true);
        if (!heading) return;
        var rootButton = firstRoot ? explorer.closest('.whole-result').querySelector('.result-disclosure')
          : source.querySelector('.loop-disclosure');
        var rootArrow = box(rootButton);
        var rootX = rootArrow ? rootArrow.left + rootArrow.width / 2
          : heading.left - (firstRoot ? 2 : .9) * unit;
        // The shared title can pin while the guide remains in document flow.
        var start = rootArrow ? rootArrow.cy + .65 * unit : heading.cy + .65 * unit;
        var targets = groups.map(function (group) {
          return { group: group, arrow: box(group.querySelector(':scope > .loop-iteration-header .loop-disclosure')) };
        }).filter(function (item) { return item.arrow; });
        if (!targets.length) return;
        var last = targets[targets.length - 1].arrow;
        if (last.cy >= start) add('M ' + rootX + ' ' + start + ' V ' + last.cy,
          'iterations', invocation.dataset.loopInvocation, invocation.dataset.loopInvocation);
        targets.forEach(function (item) {
          var arrow = item.arrow;
          add('M ' + rootX + ' ' + arrow.cy + ' H ' + (arrow.left - 7),
            'iteration', invocation.dataset.loopInvocation, item.group.dataset.loopEntry);
          var children = Array.prototype.slice.call(item.group.querySelectorAll(':scope > .loop-body > .loop-invocation'));
          children.forEach(function (child, index) {
            var label = box(child.querySelector(':scope > .loop-source'), true);
            if (!label) return;
            var x = arrow.left + arrow.width / 2;
            // A later sibling gets a local elbow: continuing a trunk through
            // the earlier child's readings would imply another ownership.
            var y = index === 0 ? arrow.cy + .65 * unit : label.top - .3 * unit;
            add('M ' + x + ' ' + Math.min(y, label.cy) + ' V ' + label.cy
              + ' H ' + (label.left - 7), 'child', item.group.dataset.loopEntry,
              child.dataset.loopInvocation);
          });
        });
      });
      svg.replaceChildren.apply(svg, paths);
    });
  }
  function queueLoopGuides() {
    if (loopGuidesQueued) return;
    loopGuidesQueued = true;
    requestAnimationFrame(function () { loopGuidesQueued = false; drawLoopGuides(); });
  }
  if (loopTrees.length) {
    var guideObserver = new ResizeObserver(queueLoopGuides);
    loopTrees.forEach(function (explorer) {
      guideObserver.observe(explorer);
      explorer.querySelectorAll('.loop-source, .loop-iteration-header').forEach(function (heading) {
        guideObserver.observe(heading);
      });
    });
    window.addEventListener('resize', queueLoopGuides);
    document.addEventListener('toggle', queueLoopGuides, true);
    document.fonts.ready.then(queueLoopGuides);
    queueLoopGuides();
  }
`;

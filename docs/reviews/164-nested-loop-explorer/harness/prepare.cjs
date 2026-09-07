const fs=require('node:fs');
const root='/private/tmp/evalens-learning-live';
for(const dir of ['workspace','user-data/User','extensions']) fs.mkdirSync(`${root}/${dir}`,{recursive:true});
fs.writeFileSync(`${root}/user-data/User/settings.json`,JSON.stringify({
 'security.workspace.trust.enabled':false,'workbench.startupEditor':'none',
 'workbench.colorTheme':'Default Dark Modern','extensions.autoCheckUpdates':false,
 'extensions.autoUpdate':false,'evalens.valuesPanel.followCursor':true,
 'evalens.valuesPanel.follow':true,'evalens.valuesPanel.outputLines':20
},null,2));
fs.copyFileSync('/Users/mbjarland/Library/Application Support/Code/User/keybindings.json',`${root}/user-data/User/keybindings.json`);
const fixtures={
 'x5-small':'for x in range(2):\n    print("x is", x)\n    for y in range(4):\n        if y == 0:\n            continue\n        print(x, y)\n',
 'x5-large':'for x in range(2):\n    for y in range(3):\n        print("page line\\n" * 5000)\n',
 'x5-million':'for x in range(1000):\n    for y in range(1000):\n        pass\n',
 'x5-unicode':'for x in range(2):\n    print("😀 outer", x)\n    for y in [0, 0, 1]:\n        if y == 0:\n            continue\n        print("😀 inner", x, y)\n    for y in [1, 1]:\n        print("🎈 sibling", x, y)\n',
 'x5-long-line':'print("x" * 60000)\nvalues = list(range(10000))\n',
 'x5-long-multiline':'print("page line\\n" * 5000)\n',
 'x5-siblings':'for outer in range(1):\n'+Array.from({length:8},(_,i)=>`    for child${i} in range(20):\n        print("sibling ${i}", child${i})\n`).join(''),
 'x5-repeated-invocations':'for outer in range(1):\n    i = 0\n    while i < 150:\n        for child in range(1):\n            print(i, child)\n        i += 1\n',
 'x5-else':'for x in range(1):\n    print("😀 outer", x)\nelse:\n    for y in range(2):\n        print("🦉 else", y)\n',
 'x5-stderr':'for x in range(2):\n    import sys\n    for y in range(2):\n        print("warning", x, y, file=sys.stderr)\n',
 'x5-silent-after-limit':'for x in range(1):\n    for y in range(2):\n        if y == 0:\n            print("x" * 70000)\n',
 'y2':'x = [1, 2, 3]\ny = x\ny.append(4)\nprint("y unaffected by rebind:", y)\nfor n in range(3):\n    print(n)\nfor n in range(100):\n    print("line", n)\n',
 'key-dispatch':'value = 6 * 7\nnext_value = value + 1\nlast_value = next_value + 1\n',
 'navigation':Array.from({length:60},(_,i)=>`value_${i} = ${i}`).join('\n')+'\n',
};
fixtures['x5-reanchor']=fixtures['x5-small'];
for(const [name,code] of Object.entries(fixtures)) fs.writeFileSync(`${root}/workspace/${name}.py`,code);
console.log('Rebuilt isolated test settings and own-source fixtures.');

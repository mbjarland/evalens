exports.activate = () => { require('./bridge.cjs').run().catch(console.error); };

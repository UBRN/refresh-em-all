// The extension scripts run through `new Function`, which Jest cannot see, so they
// are instrumented here to count toward coverage.
const fs = require('fs');
const path = require('path');
const { createInstrumenter } = require('istanbul-lib-instrument');

module.exports = function instrumentedSource(fileName) {
  const filePath = path.join(__dirname, '..', fileName);
  return createInstrumenter().instrumentSync(fs.readFileSync(filePath, 'utf8'), filePath);
};

// Tests for the address lookup: spotting P.O. boxes, splitting Google's address parts, and the verdict.
const { isPoBox, parseComponents, judge } = require('../api/address.js');
let failed = 0;
const ok = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; };

ok('PO Box 123', isPoBox('PO Box 123, Miami, FL'));
ok('P.O. Box 9', isPoBox('P.O. Box 9'));
ok('P O Box #44', isPoBox('P O Box #44'));
ok('Post Office Box 7', isPoBox('Post Office Box 7'));
ok('POB 373', isPoBox('POB 373'));
ok('a street is not a box', !isPoBox('1420 SW 8th St, Miami, FL 33135'));
ok('Boxwood Lane is not a box', !isPoBox('12 Boxwood Ln, Tampa, FL'));
ok('Pobla Street is not a box', !isPoBox('200 Pobla St'));

const C = (long_name, short_name, ...types) => ({ long_name, short_name, types });
const miami = [
  C('1420', '1420', 'street_number'), C('Southwest 8th Street', 'SW 8th St', 'route'),
  C('Miami', 'Miami', 'locality', 'political'), C('Florida', 'FL', 'administrative_area_level_1', 'political'),
  C('33135', '33135', 'postal_code'),
];
const p = parseComponents(miami);
ok('street', p.street === '1420 SW 8th St');
ok('city, state, zip', p.city === 'Miami' && p.state === 'FL' && p.zip === '33135');
ok('unit goes on the street line', parseComponents([...miami, C('204', '204', 'subpremise')]).street === '1420 SW 8th St #204');
const noNumber = parseComponents(miami.slice(1));
ok('a street with no number is noticed', noNumber.has_number === false);

ok('a normal address passes', judge(p, '1420 SW 8th St, Miami, FL 33135', null) === 'ok');
ok('no house number does not pass', judge(noNumber, 'SW 8th St, Miami, FL', null) === 'no_street_number');
ok('USPS says it is a P.O. box', judge(p, '1420 SW 8th St, Miami, FL 33135', { addressRecordType: 'P' }) === 'po_box');
ok('USPS says it is a mailbox store', judge(p, '1420 SW 8th St, Miami, FL 33135', { dpvCmra: 'Y' }) === 'mailbox_store');
ok('USPS says it is a normal street address', judge(p, '1420 SW 8th St, Miami, FL 33135', { dpvCmra: 'N', addressRecordType: 'S' }) === 'ok');

console.log(failed ? `\n${failed} failed` : '\nAll passed');
process.exit(failed ? 1 : 0);

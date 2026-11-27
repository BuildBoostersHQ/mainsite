// Tests for the customer list cleaner.
const { parseCsv, clean } = require('../api/customer-list.js');
let failed = 0;
const ok = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; };

ok('quoted commas stay in one cell', parseCsv('a,"b, c",d\n1,2,3')[0][1] === 'b, c');

const jobber = `Display Name,Company,Mobile Phone,Main Phone,E-mail,Billing Address\n"SMITH, DAVE",,(305) 555-0142,,DAVE@Example.com,"12 Elm St, Miami"\nmaria lopez,,,1-786-555-0199,,\nNo Contact,,,,,\nDave Again,,305.555.0142,,,\n`;
const a = clean(jobber);
ok('keeps the two reachable people', a.stats.kept === 2);
ok('drops the row with no phone or email', a.stats.no_contact === 1);
ok('drops the duplicate phone', a.stats.duplicates === 1);
ok('last, first is turned around', a.customers[0].first_name === 'Dave' && a.customers[0].last_name === 'Smith');
ok('phone is ten digits', a.customers[0].phone === '3055550142' && a.customers[1].phone === '7865550199');
ok('email is lowercased', a.customers[0].email === 'dave@example.com');
ok('lowercase names are capitalized', a.customers[1].first_name === 'Maria' && a.customers[1].last_name === 'Lopez');
ok('address comes through', /Elm/.test(a.customers[0].address));

const split = clean('First Name,Last Name,Phone\nAna,Diaz,3055550111\n');
ok('first and last name columns', split.customers[0].first_name === 'Ana' && split.customers[0].last_name === 'Diaz');

const bare = clean('Tom Reyes\t305-555-0101\ttom@x.com\nKim Park\t305-555-0102\t\n');
ok('works with no header row and tabs', bare.stats.kept === 2 && bare.customers[0].first_name === 'Tom' && bare.customers[1].phone === '3055550102');

ok('junk phone numbers are not kept', clean('Name,Phone\nBob,12345\n').stats.kept === 0);
ok('empty file', clean('').stats.rows === 0);

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('All customer-list tests passed.');

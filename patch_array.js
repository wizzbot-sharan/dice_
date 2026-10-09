const fs = require('fs');
let code = fs.readFileSync('worker.js', 'utf8');

const oldParse = `function parseArrayIfNeeded(val) {
    if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']')) {
        try { return JSON.parse(val); } catch(e) {}
    }
    return val;
}`;

const newParse = `function parseArrayIfNeeded(key, val) {
    if (typeof val === 'string') {
        if (val.startsWith('[') && val.endsWith(']')) {
            try { return JSON.parse(val); } catch(e) {}
        }
        // Explicitly wrap known array fields if they come as raw strings (e.g. "NA" instead of ["NA"])
        const arrayFields = ['exclude_companies', 'job_role_preferences', 'location_preferences', 'add_ons_info'];
        if (arrayFields.includes(key)) {
            return [val];
        }
    }
    return val;
}`;

code = code.replace(oldParse, newParse);
code = code.replace(/mapped\[key\] = parseArrayIfNeeded\(v\);/g, "mapped[key] = parseArrayIfNeeded(k, v);");

fs.writeFileSync('worker.js', code);
console.log('Array parse patched');

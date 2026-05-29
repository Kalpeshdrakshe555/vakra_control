import * as path from 'path';
import Mocha from 'mocha';
import * as fs from 'fs';

function getAllTestFiles(dir: string): string[] {
    let results: string[] = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat && stat.isDirectory()) {
            results = results.concat(getAllTestFiles(filePath));
        } else if (file.endsWith('.test.js')) {
            results.push(filePath);
        }
    });
    return results;
}

export function run(): Promise<void> {
    const mocha = new Mocha({
        ui: 'tdd',
        color: true
    });

    const testsRoot = path.resolve(__dirname);

    return new Promise((resolve, reject) => {
        try {
            const files = getAllTestFiles(testsRoot);
            files.forEach(f => mocha.addFile(f));

            mocha.run(failures => {
                if (failures > 0) {
                    reject(new Error(`${failures} tests failed.`));
                } else {
                    resolve();
                }
            });
        } catch (err) {
            console.error(err);
            reject(err);
        }
    });
}

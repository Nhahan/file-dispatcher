import fs from 'fs';

const directory = './test';
const fileCount = 500;

describe('File Creation Test', () => {
    beforeAll(() => {
        createTestFiles(directory, fileCount);
    });

    afterAll(() => {
        setTimeout(() => {
            deleteTestFiles(directory, fileCount);
        }, 2000);
    });

    test(`Create ${fileCount} random txt files`, () => {
        expect(fs.readdirSync(directory).filter(file => file.endsWith('.txt'))).toHaveLength(fileCount);
    });
});


const generateRandomString = (): string => [...Array(10)].map(() => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]).join('');
const createTestFiles = (directory: string, count: number): void => [...Array(count)].forEach((_, i) => fs.writeFileSync(`${directory}/file${i + 1}.txt`, generateRandomString()));
const deleteTestFiles = (directory: string, count: number): void => [...Array(count)].forEach((_, i) => fs.existsSync(`${directory}/file${i + 1}.txt`) && fs.unlinkSync(`${directory}/file${i + 1}.txt`));
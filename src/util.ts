import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function ask_yes_no(question: string) {
    const rl = readline.createInterface({ input, output });

    while (true) {
        const answer = (await rl.question(`${question} (y/n): `)).trim().toLowerCase();

        if (answer === "y" || answer === "yes") {
            rl.close();
            return true;
        }

        if (answer === "n" || answer === "no") {
            rl.close();
            return false;
        }

        ilog("Please enter y/yes or n/no.");
    }
}

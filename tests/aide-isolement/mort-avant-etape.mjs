// Un travail qui meurt avant d'avoir annoncé sa première étape : il n'a rien lu du dépôt, ce n'est pas le fait du widget.
export async function executer() {
  process.kill(process.pid, 'SIGKILL');
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}

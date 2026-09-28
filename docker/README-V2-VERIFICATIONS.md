# Vérifications au premier déploiement (VPS d'Antoine)

Rien dans `docker/execution/`, `docker/egress-proxy/` ni
`docker-compose.v2-execution.yml` n'a été construit ni démarré depuis ce
dépôt : la politique réseau de l'environnement de développement cloud qui
les a écrits bloque Docker Hub (voir `docker/README.md`). Ce qui suit n'est
donc pas une checklist de confort — c'est la première fois que chacune de
ces affirmations sera réellement mise à l'épreuve. À faire dans cet ordre,
depuis le dossier `docker/` :

```bash
docker compose -f docker-compose.v2-execution.yml build
```

## 1. Le sandbox natif de Chromium démarre sous l'utilisateur non root

Le point le plus incertain de toute l'esquisse (voir `docs/ARCHITECTURE-V2.md`
§4) : `cap_drop: ALL` + `no-new-privileges` peuvent empêcher les namespaces
utilisateur dont Chromium a besoin pour son sandbox natif.

```bash
docker compose -f docker-compose.v2-execution.yml run --rm execution-audit \
  https://github.com/lombre33/Grist_Table_structure_import
```

Un audit qui se termine normalement (rapport JSON dans `./out/`), **sans**
la ligne `⚠ --no-sandbox` dans la sortie, confirme le sandbox actif. S'il
plante au lancement de Chromium au lieu de dégrader proprement l'axe D
(`D-INDISPONIBLE`), c'est ce point précis qui bloque — voir la note du
service `execution-audit` dans le compose pour la marche à suivre (ne
jamais céder à `--no-sandbox`, ajouter une couche d'isolation à la place).

## 2. Le réseau est fermé par défaut, pas seulement filtré en applicatif

`reseau-ferme` est déclaré `internal: true` : `execution-audit` ne doit
avoir *aucune* route vers Internet en dehors de `egress-proxy`, quel que
soit le protocole.

```bash
docker compose -f docker-compose.v2-execution.yml run --rm execution-audit \
  sh -c "wget -T 5 -O- https://exemple-hors-liste.invalid || echo 'ÉCHEC ATTENDU'"
```

Doit échouer (pas de route), **pas** un simple refus HTTP. Si ça réussit,
`reseau-ferme` ne fait pas ce que le fichier prétend.

## 3. `git clone` et `npm audit` passent réellement par `egress-proxy`

Ajoutées le 2026-09-28 après une revue de sécurité qui a trouvé qu'aucune
variable ne disait à `git`/`npm` d'utiliser le proxy — sans elles, le job
échoue simplement faute de route (voir point 2), il ne contourne rien,
mais il ne marche pas non plus.

```bash
# Doit réussir (github.com est dans la liste blanche de squid.conf) :
docker compose -f docker-compose.v2-execution.yml run --rm execution-audit \
  sh -c "git clone --depth 1 https://github.com/lombre33/Grist_Table_structure_import /tmp/t && echo OK"

# Doit échouer (hôte hors liste blanche) :
docker compose -f docker-compose.v2-execution.yml run --rm execution-audit \
  sh -c "git clone --depth 1 https://gitlab.gnome.org/GNOME/gimp /tmp/t2 && echo 'FUITE — À CORRIGER' || echo 'REJET ATTENDU'"
```

## 4. Une URL SSH (`git@hôte:chemin`) n'ouvre pas de voie parallèle

`HTTP_PROXY`/`HTTPS_PROXY` ne s'appliquent pas au transport SSH de git —
relevé par la même revue. L'hypothèse (non éprouvée) est que `reseau-ferme`
coupe court quel que soit le protocole, puisqu'il n'y a de route que vers
`egress-proxy`, qui ne relaie pas SSH.

```bash
docker compose -f docker-compose.v2-execution.yml run --rm execution-audit \
  sh -c "timeout 10 git ls-remote git@github.com:lombre33/Grist_Table_structure_import.git || echo 'ÉCHEC ATTENDU (pas de route)'"
```

Doit échouer par absence de route (timeout/unreachable), pas seulement par
absence de clé SSH — la différence compte : un échec de credentials ne
prouve rien sur l'isolation réseau.

## 5. La limite mémoire (cgroups v2) coupe réellement

`ulimit -v` est structurellement inutilisable avec Chromium (voir constat
10c, `docs/ARCHITECTURE-V2.md` §1) — seuls les cgroups conviennent. `mem_limit:
768m` dans le compose s'appuie dessus, jamais vérifié faute de VPS.

```bash
docker info | grep -i cgroup   # confirmer cgroups v2 (unified) avant tout le reste
```

Un audit normal doit rester sous 768 Mio et se terminer ; un widget qui
alloue délibérément au-delà doit voir son conteneur tué par le noyau (`docker
compose ... ps` montre un statut OOMKilled), pas planter Chromium en
silence ni continuer indéfiniment.

---

Ce fichier documente des vérifications à faire, pas des résultats obtenus —
aucune des commandes ci-dessus n'a tourné depuis ce dépôt.

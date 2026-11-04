# Publicare NICUBANK pe Render

Configurația din `render.yaml` publică aplicația ca Web Service Node în regiunea Frankfurt. Render construiește cu `npm ci --include=optional && npm run build`, pornește cu `npm start` și atașează discul `/var/data` pentru baza SQLite, fișierele încărcate și cheia locală de criptare.

## Înainte de publicare

1. Creează un depozit **privat și gol** GitHub, fără README, licență sau `.gitignore`. Rulează `PUBLICA-GITHUB.cmd` din acest folder și lipește adresa HTTPS afișată de GitHub. Scriptul îți arată fișierele și cere confirmare înainte de upload.
2. Verifică `.gitignore`. Nu încărca `.env`, `node_modules`, `dist`, `server/data`, fișiere `.sqlite` sau `local-encryption.key`.
3. În Render, conectează depozitul și creează serviciul din Blueprint-ul `render.yaml`. Planul `starter` și discul persistent sunt necesare pentru ca baza și documentele să nu dispară la restart sau redeploy.
4. După deploy, Render afișează adresa `*.onrender.com`. Deschide secțiunea Environment a serviciului și copiază valoarea `SETUP_TOKEN`.
5. Deschide adresa publică și creează contul principal folosind codul `SETUP_TOKEN`. După crearea contului, endpoint-ul public de configurare este blocat.
6. Opțional, adaugă `OPENAI_API_KEY` în Environment pentru OCR AI și răspunsuri AI. Nu pune cheia în GitHub.
7. Pentru domeniul propriu, adaugă-l în setările serviciului Render și introdu la furnizorul DNS exact înregistrările afișate de Render. Render configurează HTTPS automat.

## Date locale

Deploy-ul pornește cu o bază cloud goală. Contul creat pe acest calculator și orice operațiuni locale nu sunt trimise împreună cu codul. Nu urca baza SQLite pe GitHub. Dacă vrei să muți datele locale în cloud, fă mai întâi o copie de siguranță și planifică migrarea separat, apoi verifică rezultatul înainte de a continua lucrul în baza cloud.

## Cost și limite

Discul persistent Render nu este disponibil pe instanțele gratuite. Fără el, baza SQLite și documentele locale se pot pierde la restart sau redeploy. Discul și serviciul web au costuri separate. Un serviciu cu disc persistent folosește o singură instanță; configurația este potrivită pentru utilizare personală/de echipă mică, nu pentru scalare pe mai multe instanțe.

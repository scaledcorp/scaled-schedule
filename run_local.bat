@echo off
rem Opens scaled Schedule in your browser from this folder (needs Python).
cd /d "%~dp0"
start "" http://localhost:5080/app/
python -m http.server 5080 --bind 127.0.0.1

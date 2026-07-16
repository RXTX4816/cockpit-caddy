Name:           cockpit-caddy
Version:        %{version}
Release:        1%{?dist}
Summary:        Caddy reverse proxy management plugin for Cockpit
License:        MIT
URL:            https://github.com/RXTX4816/cockpit-caddy
Source0:        cockpit-caddy-%{version}.tar.gz
BuildArch:      noarch
Requires:       cockpit

%description
A Cockpit plugin for managing Caddy reverse proxy from the Cockpit web
interface. Configure port-based reverse proxying with automatic self-signed
TLS certificates — no DNS or subdomains required.

Each service is accessible via its own HTTPS port (e.g. https://192.168.1.100:8443).
Requires Caddy with the Admin API enabled (default: localhost:2019).

%prep
%setup -q -n cockpit-caddy

%install
install -d %{buildroot}%{_datadir}/cockpit/cockpit-caddy
install -m 0644 main.js       %{buildroot}%{_datadir}/cockpit/cockpit-caddy/
install -m 0644 main.css      %{buildroot}%{_datadir}/cockpit/cockpit-caddy/
install -m 0644 manifest.json %{buildroot}%{_datadir}/cockpit/cockpit-caddy/
install -m 0644 index.html    %{buildroot}%{_datadir}/cockpit/cockpit-caddy/
cp -r assets %{buildroot}%{_datadir}/cockpit/cockpit-caddy/

%files
%doc README.md
%{_datadir}/cockpit/cockpit-caddy/

%changelog
* Fri Jun 20 2026 RXTX4816 <RXTX4816@proton.me> - 0.1.0-1
- Initial package

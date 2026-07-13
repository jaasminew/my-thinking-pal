package search

import (
	"context"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// UrlMeta is the og:description / og:image payload for an inspiration card.
type UrlMeta struct {
	Description string `json:"description,omitempty"`
	Image       string `json:"image,omitempty"`
}

// MetaFetcher resolves page metadata with SSRF protections.
type MetaFetcher interface {
	Fetch(ctx context.Context, rawURL string) UrlMeta
}

type URLMetaClient struct {
	client *http.Client
	lookup func(ctx context.Context, host string) ([]net.IP, error)
}

func NewURLMetaClient() *URLMetaClient {
	c := &URLMetaClient{
		lookup: defaultLookup,
	}
	c.client = &http.Client{
		Timeout: 6 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse // manual redirect validation
		},
		Transport: &http.Transport{
			// Direct only: a generic HTTPS_PROXY would re-open SSRF via DNS rebinding.
			Proxy: nil,
			DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				host, port, err := net.SplitHostPort(address)
				if err != nil {
					return nil, err
				}
				ips, err := c.lookup(ctx, host)
				if err != nil {
					return nil, err
				}
				if len(ips) == 0 || !allPublicIPs(ips) {
					return nil, errNonPublic
				}
				var last error
				for _, ip := range ips {
					d := net.Dialer{Timeout: 4 * time.Second}
					conn, err := d.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
					if err == nil {
						return conn, nil
					}
					last = err
				}
				if last == nil {
					last = errNonPublic
				}
				return nil, last
			},
		},
	}
	return c
}

var errNonPublic = &net.OpError{Op: "dial", Err: errString("DNS resolved to a non-public address")}

type errString string

func (e errString) Error() string { return string(e) }

func defaultLookup(ctx context.Context, host string) ([]net.IP, error) {
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	out := make([]net.IP, 0, len(addrs))
	for _, a := range addrs {
		out = append(out, a.IP)
	}
	return out, nil
}

func (c *URLMetaClient) Fetch(ctx context.Context, rawURL string) UrlMeta {
	u, err := validatePublicURL(ctx, rawURL, c.lookup)
	if err != nil {
		return UrlMeta{}
	}
	for redirects := 0; redirects <= 3; redirects++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
		if err != nil {
			return UrlMeta{}
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; ThinkingPal/1.0; +https://mythinkingpal.xyz)")
		req.Header.Set("Accept", "text/html")

		res, err := c.client.Do(req)
		if err != nil {
			return UrlMeta{}
		}

		if res.StatusCode >= 300 && res.StatusCode < 400 {
			loc := res.Header.Get("Location")
			_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1024))
			res.Body.Close()
			if loc == "" || redirects == 3 {
				return UrlMeta{}
			}
			next, err := u.Parse(loc)
			if err != nil {
				return UrlMeta{}
			}
			u, err = validatePublicURL(ctx, next.String(), c.lookup)
			if err != nil {
				return UrlMeta{}
			}
			continue
		}

		ct := res.Header.Get("Content-Type")
		if res.StatusCode < 200 || res.StatusCode >= 300 || !strings.Contains(ct, "html") {
			_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1024))
			res.Body.Close()
			return UrlMeta{}
		}
		htmlBody, _ := io.ReadAll(io.LimitReader(res.Body, 200_000))
		res.Body.Close()
		pageURL := res.Request.URL.String()
		if pageURL == "" {
			pageURL = u.String()
		}
		return parseURLMeta(string(htmlBody), pageURL)
	}
	return UrlMeta{}
}

func validatePublicURL(ctx context.Context, raw string, lookup func(context.Context, string) ([]net.IP, error)) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, errString("Only HTTP(S) URLs are allowed")
	}
	if u.User != nil {
		return nil, errString("URL credentials are not allowed")
	}
	if u.Port() != "" && u.Port() != "80" && u.Port() != "443" {
		return nil, errString("Non-standard ports are not allowed")
	}

	host := strings.ToLower(u.Hostname())
	host = strings.TrimSuffix(host, ".")
	if host == "localhost" ||
		strings.HasSuffix(host, ".localhost") ||
		strings.HasSuffix(host, ".local") ||
		strings.HasSuffix(host, ".internal") {
		return nil, errString("Private hosts are not allowed")
	}

	if ip := net.ParseIP(host); ip != nil {
		if !IsPublicIP(ip) {
			return nil, errString("Private addresses are not allowed")
		}
		return u, nil
	}

	ips, err := lookup(ctx, host)
	if err != nil {
		return nil, err
	}
	if len(ips) == 0 || !allPublicIPs(ips) {
		return nil, errString("Host resolves to a non-public address")
	}
	return u, nil
}

func allPublicIPs(ips []net.IP) bool {
	for _, ip := range ips {
		if !IsPublicIP(ip) {
			return false
		}
	}
	return true
}

// IsPublicIP reports whether address is a globally routable public IP.
func IsPublicIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		a, b := int(v4[0]), int(v4[1])
		if a == 0 || a == 10 || a == 127 ||
			(a == 100 && b >= 64 && b <= 127) ||
			(a == 169 && b == 254) ||
			(a == 172 && b >= 16 && b <= 31) ||
			(a == 192 && (b == 0 || b == 168)) ||
			(a == 198 && (b == 18 || b == 19)) ||
			a >= 224 {
			return false
		}
		if (a == 192 && b == 0 && v4[2] == 2) ||
			(a == 198 && b == 51 && v4[2] == 100) ||
			(a == 203 && b == 0 && v4[2] == 113) {
			return false
		}
		return true
	}

	normalized := strings.ToLower(ip.String())
	if normalized == "::" || normalized == "::1" {
		return false
	}
	if strings.HasPrefix(normalized, "fc") || strings.HasPrefix(normalized, "fd") {
		return false
	}
	if len(normalized) >= 3 {
		prefix := normalized[:3]
		if prefix == "fe8" || prefix == "fe9" || prefix == "fea" || prefix == "feb" {
			return false
		}
	}
	if strings.HasPrefix(normalized, "ff") || strings.HasPrefix(normalized, "2001:db8:") {
		return false
	}
	return true
}

var (
	metaTagRe = regexp.MustCompile(`(?i)<meta[^>]+(?:property|name)=["']([^"']+)["'][^>]*>`)
	contentRe = regexp.MustCompile(`(?i)content=["']([^"']*)["']`)
)

func parseURLMeta(htmlBody, pageURL string) UrlMeta {
	meta := func(names []string) string {
		for _, name := range names {
			for _, tag := range metaTagRe.FindAllString(htmlBody, -1) {
				m := metaTagRe.FindStringSubmatch(tag)
				if len(m) < 2 || !strings.EqualFold(m[1], name) {
					continue
				}
				c := contentRe.FindStringSubmatch(tag)
				if len(c) < 2 {
					continue
				}
				val := strings.TrimSpace(html.UnescapeString(c[1]))
				if val != "" {
					return val
				}
			}
		}
		return ""
	}

	desc := meta([]string{"og:description", "twitter:description", "description"})
	if len(desc) > 300 {
		desc = desc[:300]
	}
	image := meta([]string{"og:image", "og:image:url", "twitter:image"})
	if image != "" {
		if abs, err := url.Parse(image); err == nil {
			if base, err2 := url.Parse(pageURL); err2 == nil {
				image = base.ResolveReference(abs).String()
			}
		} else {
			image = ""
		}
	}
	return UrlMeta{Description: desc, Image: image}
}

// FuncMetaFetcher adapts a function to MetaFetcher (tests).
type FuncMetaFetcher func(ctx context.Context, rawURL string) UrlMeta

func (f FuncMetaFetcher) Fetch(ctx context.Context, rawURL string) UrlMeta {
	return f(ctx, rawURL)
}

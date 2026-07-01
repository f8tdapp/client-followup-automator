"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type Client = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  status: string | null;
  notes: string | null;
  tags: string[] | null;
  last_contacted_at: string | null;
  next_follow_up_at: string | null;
  opened_count: number | null;
  clicked_count: number | null;
  unsubscribed_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type ClientForm = {
  first_name: string;
  last_name: string;
  company: string;
  email: string;
  phone: string;
  notes: string;
};

const emptyForm: ClientForm = {
  first_name: "",
  last_name: "",
  company: "",
  email: "",
  phone: "",
  notes: "",
};

async function getSupabase() {
  const { supabase } = await import("@/lib/supabase");

  return supabase;
}

function formatDate(value: string | null) {
  if (!value) {
    return "Never";
  }

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function getClientName(client: Client) {
  const fullName = [client.first_name, client.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

  return fullName || "Unnamed client";
}

export default function Dashboard() {
  const [clients, setClients] = useState<Client[]>([]);
  const [form, setForm] = useState<ClientForm>(emptyForm);
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  async function loadClients() {
    setIsLoading(true);
    setError("");

    try {
      const supabase = await getSupabase();
      const { data, error: fetchError } = await supabase
        .from("clients")
        .select("*")
        .order("created_at", { ascending: false });

      if (fetchError) {
        setError(fetchError.message);
        setClients([]);
      } else {
        setClients(data ?? []);
      }
    } catch (fetchError) {
      setError(
        fetchError instanceof Error
          ? fetchError.message
          : "Unable to load clients.",
      );
      setClients([]);
    }

    setIsLoading(false);
  }

  useEffect(() => {
    let isActive = true;

    getSupabase()
      .then((supabase) =>
        supabase.from("clients").select("*").order("created_at", {
          ascending: false,
        }),
      )
      .then(({ data, error: fetchError }) => {
        if (!isActive) {
          return;
        }

        if (fetchError) {
          setError(fetchError.message);
          setClients([]);
        } else {
          setClients(data ?? []);
        }

        setIsLoading(false);
      })
      .catch((fetchError) => {
        if (!isActive) {
          return;
        }

        setError(
          fetchError instanceof Error
            ? fetchError.message
            : "Unable to load clients.",
        );
        setClients([]);
        setIsLoading(false);
      });

    return () => {
      isActive = false;
    };
  }, []);

  const filteredClients = useMemo(() => {
    const query = search.trim().toLowerCase();

    if (!query) {
      return clients;
    }

    return clients.filter((client) => {
      const haystack = [
        client.first_name,
        client.last_name,
        client.company,
        client.email,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    });
  }, [clients, search]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setError("");
    setIsSaving(true);

    try {
      const supabase = await getSupabase();
      const { error: insertError } = await supabase.from("clients").insert({
        first_name: form.first_name.trim() || null,
        last_name: form.last_name.trim() || null,
        company: form.company.trim() || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        notes: form.notes.trim() || null,
      });

      if (insertError) {
        setError(insertError.message);
      } else {
        setMessage("Client added successfully.");
        setForm(emptyForm);
        await loadClients();
      }
    } catch (insertError) {
      setError(
        insertError instanceof Error
          ? insertError.message
          : "Unable to add client.",
      );
    }

    setIsSaving(false);
  }

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="flex flex-col gap-2 border-b border-slate-200 pb-5">
          <p className="text-sm font-medium uppercase tracking-wide text-cyan-700">
            Client follow-up automator
          </p>
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
            <div>
              <h1 className="text-3xl font-semibold text-slate-950">
                Client database
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                Track contact details and engagement signals before follow-up
                automation is added.
              </p>
            </div>
            <div className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm">
              <span className="font-semibold text-slate-950">
                {clients.length}
              </span>{" "}
              total clients
            </div>
          </div>
        </header>

        {(message || error) && (
          <div
            className={`rounded-md border px-4 py-3 text-sm ${
              error
                ? "border-red-200 bg-red-50 text-red-800"
                : "border-emerald-200 bg-emerald-50 text-emerald-800"
            }`}
          >
            {error || message}
          </div>
        )}

        <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="min-w-0 rounded-md border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-base font-semibold text-slate-950">
                  Clients
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {filteredClients.length} visible
                </p>
              </div>
              <label className="w-full sm:max-w-xs">
                <span className="sr-only">Search clients</span>
                <input
                  className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search name, company, or email"
                  type="search"
                />
              </label>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3 font-semibold">Name</th>
                    <th className="px-4 py-3 font-semibold">Company</th>
                    <th className="px-4 py-3 font-semibold">Email</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Last contacted</th>
                    <th className="px-4 py-3 font-semibold">Opens</th>
                    <th className="px-4 py-3 font-semibold">Clicks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {isLoading ? (
                    <tr>
                      <td className="px-4 py-8 text-center text-slate-500" colSpan={7}>
                        Loading clients...
                      </td>
                    </tr>
                  ) : filteredClients.length > 0 ? (
                    filteredClients.map((client) => (
                      <tr
                        className="transition hover:bg-slate-50"
                        key={client.id}
                      >
                        <td className="px-4 py-3 font-medium text-slate-950">
                          {getClientName(client)}
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          {client.company || "-"}
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          {client.email || "-"}
                        </td>
                        <td className="px-4 py-3">
                          <span className="inline-flex rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-700">
                            {client.status || "New"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          {formatDate(client.last_contacted_at)}
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          {client.opened_count ?? 0}
                        </td>
                        <td className="px-4 py-3 text-slate-600">
                          {client.clicked_count ?? 0}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td className="px-4 py-8 text-center text-slate-500" colSpan={7}>
                        No clients found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <aside className="rounded-md border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-semibold text-slate-950">
              Add client
            </h2>
            <form className="mt-5 flex flex-col gap-4" onSubmit={handleSubmit}>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
                <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                  First name
                  <input
                    className="h-10 rounded-md border border-slate-300 px-3 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        first_name: event.target.value,
                      }))
                    }
                    value={form.first_name}
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                  Last name
                  <input
                    className="h-10 rounded-md border border-slate-300 px-3 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        last_name: event.target.value,
                      }))
                    }
                    value={form.last_name}
                  />
                </label>
              </div>

              <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                Company
                <input
                  className="h-10 rounded-md border border-slate-300 px-3 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      company: event.target.value,
                    }))
                  }
                  value={form.company}
                />
              </label>

              <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                Email
                <input
                  className="h-10 rounded-md border border-slate-300 px-3 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      email: event.target.value,
                    }))
                  }
                  type="email"
                  value={form.email}
                />
              </label>

              <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                Phone
                <input
                  className="h-10 rounded-md border border-slate-300 px-3 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      phone: event.target.value,
                    }))
                  }
                  type="tel"
                  value={form.phone}
                />
              </label>

              <label className="flex flex-col gap-1.5 text-sm font-medium text-slate-700">
                Notes
                <textarea
                  className="min-h-28 resize-y rounded-md border border-slate-300 px-3 py-2 font-normal outline-none transition focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      notes: event.target.value,
                    }))
                  }
                  value={form.notes}
                />
              </label>

              <button
                className="h-10 rounded-md bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                disabled={isSaving}
                type="submit"
              >
                {isSaving ? "Adding..." : "Add client"}
              </button>
            </form>
          </aside>
        </section>
      </div>
    </main>
  );
}

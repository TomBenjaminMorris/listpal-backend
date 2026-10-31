module.exports.handler = async (event) => {
  const userID = "u#" + event.request.userAttributes.sub
  try {
    const request = new Request("https://api.vinsp.in/new-user", {
      method: "POST",
      body: JSON.stringify({ userID: userID }),
    });

    const response = await fetch(request);
    if (!response.ok) {
      console.error("User creation failed with status", response.status);
    }
  } catch (err) {
    console.error("Error getting data: ", err);
    throw err;
  }
  return event;
};
